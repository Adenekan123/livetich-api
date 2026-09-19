import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GITHUB_API, GitHubAppService } from './github-app.service';

/**
 * The GitHub REST calls Livetich actually makes, and no more.
 *
 * Written against `fetch` rather than a client library: this is a handful of
 * endpoints, and every one of them sits in the path of creating or reading a
 * student's private repository. A thin, readable surface is worth more here
 * than the conveniences a library would add.
 *
 * Every method takes the installation id, so a call is always made as one
 * specific institution. There is no ambient "current org" to get wrong.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface Repository {
  id: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
  htmlUrl: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  committedAt: string | null;
  htmlUrl: string;
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff for this file. Absent on binaries and very large files. */
  patch?: string;
}

export interface CommitComparison {
  aheadBy: number;
  totalCommits: number;
  files: ChangedFile[];
  /** True when GitHub truncated the file list (very large diffs). */
  truncated: boolean;
}

/** One file in the repository at a commit. */
export interface TreeEntry {
  path: string;
  /** Bytes, so oversized files can be skipped before being fetched. */
  size: number;
}

interface GitHubRepoPayload {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  archived: boolean;
  html_url: string;
}

@Injectable()
export class GitHubApiService {
  private readonly log = new Logger(GitHubApiService.name);

  constructor(private readonly app: GitHubAppService) {}

  // ---- Repositories -------------------------------------------------------

  /** The repository, or null when it does not exist. The existence check that
   *  makes provisioning idempotent (§39). */
  async getRepo(
    installationId: string,
    ref: RepoRef,
  ): Promise<Repository | null> {
    const res = await this.request(
      installationId,
      `/repos/${ref.owner}/${ref.repo}`,
    );
    if (res.status === 404) return null;
    return toRepository(
      await this.json<GitHubRepoPayload>(res, 'read repository'),
    );
  }

  /**
   * Create a private repository in the organisation, seeded from the program's
   * template when it has one.
   *
   * Both paths are private by default and neither is ever `auto_init` public —
   * a student repository containing coursework must not be world-readable even
   * for the seconds between creation and the first permission change.
   */
  async createRepoFromTemplate(
    installationId: string,
    params: {
      templateOwner: string;
      templateRepo: string;
      owner: string;
      name: string;
      description?: string;
    },
  ): Promise<Repository> {
    const res = await this.request(
      installationId,
      `/repos/${params.templateOwner}/${params.templateRepo}/generate`,
      {
        method: 'POST',
        body: {
          owner: params.owner,
          name: params.name,
          description: params.description,
          private: true,
          include_all_branches: false,
        },
      },
    );
    return toRepository(
      await this.json<GitHubRepoPayload>(
        res,
        'create repository from template',
      ),
    );
  }

  /** Create an empty private repository (no template configured). */
  async createRepo(
    installationId: string,
    params: { org: string; name: string; description?: string },
  ): Promise<Repository> {
    const res = await this.request(
      installationId,
      `/orgs/${params.org}/repos`,
      {
        method: 'POST',
        body: {
          name: params.name,
          description: params.description,
          private: true,
          // Gives the repo a first commit, so there is a branch to clone and
          // push to. Cloning an empty repository is a confusing first experience.
          auto_init: true,
        },
      },
    );
    return toRepository(
      await this.json<GitHubRepoPayload>(res, 'create repository'),
    );
  }

  /**
   * Give one student push access to one repository.
   *
   * `push`, never `admin`: a student may commit their work but must not be
   * able to change who else can see it (§33).
   */
  async addCollaborator(
    installationId: string,
    ref: RepoRef,
    username: string,
    permission: 'push' | 'pull' = 'push',
  ): Promise<void> {
    const res = await this.request(
      installationId,
      `/repos/${ref.owner}/${ref.repo}/collaborators/${encodeURIComponent(username)}`,
      { method: 'PUT', body: { permission } },
    );
    // 201 invitation created, 204 already a collaborator. Both are success.
    if (res.status !== 201 && res.status !== 204) {
      await this.fail(res, 'grant repository access');
    }
  }

  /** Archive rather than delete: a finished program's code is evidence (§34). */
  async archiveRepo(installationId: string, ref: RepoRef): Promise<void> {
    const res = await this.request(
      installationId,
      `/repos/${ref.owner}/${ref.repo}`,
      { method: 'PATCH', body: { archived: true } },
    );
    if (!res.ok) await this.fail(res, 'archive repository');
  }

  // ---- Commits ------------------------------------------------------------

  /**
   * Resolve a ref to a commit. Used to confirm that the SHA a student's editor
   * reported really exists in their repository before a submission is pinned
   * to it — the client is never trusted for this (§44).
   */
  async getCommit(
    installationId: string,
    ref: RepoRef,
    sha: string,
  ): Promise<CommitInfo | null> {
    const res = await this.request(
      installationId,
      `/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(sha)}`,
    );
    if (res.status === 404 || res.status === 422) return null;
    const body = await this.json<{
      sha: string;
      html_url: string;
      commit: { message: string; committer?: { date?: string } };
    }>(res, 'read commit');
    return {
      sha: body.sha,
      message: body.commit?.message ?? '',
      committedAt: body.commit?.committer?.date ?? null,
      htmlUrl: body.html_url,
    };
  }

  /**
   * What changed between two commits — the basis for reviewing a diff instead
   * of a whole repository on every attempt (§26).
   */
  async compareCommits(
    installationId: string,
    ref: RepoRef,
    base: string,
    head: string,
  ): Promise<CommitComparison | null> {
    const res = await this.request(
      installationId,
      `/repos/${ref.owner}/${ref.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    if (res.status === 404) return null;
    const body = await this.json<{
      ahead_by?: number;
      total_commits?: number;
      files?: {
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      }[];
    }>(res, 'compare commits');
    const files = body.files ?? [];
    return {
      aheadBy: body.ahead_by ?? 0,
      totalCommits: body.total_commits ?? 0,
      files: files.map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
      // GitHub caps the compare endpoint at 300 files.
      truncated: files.length >= 300,
    };
  }

  /**
   * Every file in the repository at one commit, as paths and sizes.
   *
   * Used for a first submission, which has no earlier attempt to diff against.
   * Sizes come back with the listing, so oversized and binary files can be
   * skipped before any of them is fetched.
   */
  async listTree(
    installationId: string,
    ref: RepoRef,
    sha: string,
  ): Promise<{ files: TreeEntry[]; truncated: boolean } | null> {
    const res = await this.request(
      installationId,
      `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    );
    if (res.status === 404 || res.status === 422) return null;
    const body = await this.json<{
      truncated?: boolean;
      tree?: { path: string; type: string; size?: number }[];
    }>(res, 'read the repository');
    return {
      files: (body.tree ?? [])
        .filter((t) => t.type === 'blob')
        .map((t) => ({ path: t.path, size: t.size ?? 0 })),
      // Very large repositories come back partial rather than failing.
      truncated: Boolean(body.truncated),
    };
  }

  /**
   * One file's text at a commit.
   *
   * Returns null for anything that is not readable text — binaries, and files
   * GitHub declines to inline — so a caller can skip them without special
   * casing. The contents endpoint base64-encodes, which also means a file that
   * decodes with replacement characters was never source code.
   */
  async readFile(
    installationId: string,
    ref: RepoRef,
    sha: string,
    path: string,
  ): Promise<string | null> {
    const res = await this.request(
      installationId,
      `/repos/${ref.owner}/${ref.repo}/contents/${path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}?ref=${encodeURIComponent(sha)}`,
    );
    if (res.status === 404 || res.status === 403) return null;
    const body = await this.json<{
      encoding?: string;
      content?: string;
      type?: string;
    }>(res, 'read a file');
    if (body.type !== 'file' || body.encoding !== 'base64' || !body.content) {
      return null;
    }
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    // A NUL byte means this was never text, whatever its extension claimed.
    return text.includes(' ') ? null : text;
  }

  // ---- Plumbing -----------------------------------------------------------

  private async request(
    installationId: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    const token = await this.app.installationToken(installationId);
    const res = await fetch(`${GITHUB_API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

    // A token GitHub no longer accepts is worth nothing cached; drop it so the
    // next attempt mints a fresh one rather than repeating the failure.
    if (res.status === 401) this.app.forget(installationId);
    return res;
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) await this.fail(res, what);
    return (await res.json()) as T;
  }

  /** Always throws. Logs GitHub's reason; shows the instructor a plain one. */
  private async fail(res: Response, what: string): Promise<never> {
    let reason = res.statusText;
    try {
      const text = await res.text();
      reason =
        (JSON.parse(text) as { message?: string })?.message ??
        text.slice(0, 200);
    } catch {
      // Keep statusText.
    }
    this.log.error(`GitHub could not ${what}: ${res.status} ${reason}`);
    throw new ServiceUnavailableException(`GitHub could not ${what}`);
  }
}

function toRepository(payload: GitHubRepoPayload): Repository {
  return {
    // Stored and compared as a string: an opaque identifier, never arithmetic,
    // and a bigint would throw the moment a response is serialised.
    id: String(payload.id),
    name: payload.name,
    fullName: payload.full_name,
    private: payload.private,
    defaultBranch: payload.default_branch,
    archived: payload.archived,
    htmlUrl: payload.html_url,
  };
}
