import {
  MAX_REPO_NAME,
  RepoNameError,
  competitionRepositoryName,
  repositoryName,
  slugPart,
} from './repo-name.util';

describe('slugPart', () => {
  it('lowercases and keeps letters and digits', () => {
    expect(slugPart('SEP26')).toBe('sep26');
    expect(slugPart('FE')).toBe('fe');
  });

  it('collapses anything else to single dashes without edges', () => {
    expect(slugPart('  Frontend   Development!! ')).toBe(
      'frontend-development',
    );
    expect(slugPart('C#')).toBe('c');
    expect(slugPart('--odd--')).toBe('odd');
  });

  it('strips accents rather than dropping the letter', () => {
    expect(slugPart('Café')).toBe('cafe');
  });

  it('returns empty for input with nothing usable in it', () => {
    expect(slugPart('!!!')).toBe('');
    expect(slugPart('')).toBe('');
  });
});

describe('repositoryName', () => {
  const parts = { programCode: 'FE', cohortCode: 'SEP26', enrollmentNo: 1042 };

  it('builds the documented shape', () => {
    expect(repositoryName(parts)).toBe('fe-sep26-enr1042');
  });

  it('is deterministic — the retry safety the provisioner depends on', () => {
    expect(repositoryName(parts)).toBe(repositoryName({ ...parts }));
  });

  it('never contains the student name, because it never receives one', () => {
    const name = repositoryName(parts);
    expect(name).not.toMatch(/aisha|bello/i);
  });

  it('separates two students in the same cohort', () => {
    expect(repositoryName({ ...parts, enrollmentNo: 1043 })).toBe(
      'fe-sep26-enr1043',
    );
  });

  it('separates the same student across two programs', () => {
    expect(
      repositoryName({ ...parts, programCode: 'BE', cohortCode: 'JAN27' }),
    ).toBe('be-jan27-enr1042');
  });

  it('refuses rather than inventing a name when a code is missing', () => {
    expect(() => repositoryName({ ...parts, programCode: null })).toThrow(
      RepoNameError,
    );
    expect(() => repositoryName({ ...parts, cohortCode: '' })).toThrow(
      RepoNameError,
    );
    expect(() => repositoryName({ ...parts, programCode: '###' })).toThrow(
      RepoNameError,
    );
  });

  it('refuses a missing or nonsense enrolment number', () => {
    expect(() => repositoryName({ ...parts, enrollmentNo: null })).toThrow(
      RepoNameError,
    );
    expect(() => repositoryName({ ...parts, enrollmentNo: 0 })).toThrow(
      RepoNameError,
    );
    expect(() => repositoryName({ ...parts, enrollmentNo: -1 })).toThrow(
      RepoNameError,
    );
    expect(() => repositoryName({ ...parts, enrollmentNo: 1.5 })).toThrow(
      RepoNameError,
    );
  });

  it('refuses a name GitHub would reject for length', () => {
    expect(() =>
      repositoryName({ ...parts, programCode: 'x'.repeat(MAX_REPO_NAME) }),
    ).toThrow(RepoNameError);
  });
});

describe('competitionRepositoryName', () => {
  it('keeps competition work in its own namespace', () => {
    expect(
      competitionRepositoryName({
        competitionCode: 'FC26',
        enrollmentNo: 1042,
      }),
    ).toBe('cmp-fc26-enr1042');
  });

  it('cannot collide with a course repository for the same entrant', () => {
    const course = repositoryName({
      programCode: 'FC26',
      cohortCode: 'X',
      enrollmentNo: 1042,
    });
    const competition = competitionRepositoryName({
      competitionCode: 'FC26',
      enrollmentNo: 1042,
    });
    expect(course).not.toBe(competition);
  });

  it('refuses without a code or a number', () => {
    expect(() =>
      competitionRepositoryName({ competitionCode: null, enrollmentNo: 1 }),
    ).toThrow(RepoNameError);
    expect(() =>
      competitionRepositoryName({
        competitionCode: 'FC26',
        enrollmentNo: null,
      }),
    ).toThrow(RepoNameError);
  });
});
