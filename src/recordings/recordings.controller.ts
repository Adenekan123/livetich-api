import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { AllowRecorder, Public } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { ShareRecordingDto } from './dto/share-recording.dto';
import { RecordingsService } from './recordings.service';

@Controller()
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  /** What the classroom's Record button should show. */
  @Get('sessions/:id/recording')
  status(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.recordings.statusFor(user, id);
  }

  @HttpCode(200)
  @Post('sessions/:id/recording/start')
  start(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.recordings.start(user, id);
  }

  @HttpCode(200)
  @Post('sessions/:id/recording/stop')
  stop(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.recordings.stop(user, id);
  }

  /**
   * Everything LiveKit's headless browser needs to watch the class it was sent
   * to film: a hidden LiveKit token for the media, and the session's shape.
   *
   * The only route a recorder token may reach — the guard refuses it anywhere
   * else — so the credential in that browser's URL bar cannot act as the
   * instructor it names.
   */
  @AllowRecorder()
  @Get('sessions/:id/recorder-context')
  recorderContext(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.recordings.recorderContext(user, id);
  }

  /** The workspace's gallery, with its storage usage. */
  @Get('recordings')
  list(@CurrentUser() user: JwtPayload) {
    return this.recordings.list(user);
  }

  /** Short-lived URL that plays straight from the store. */
  @Get('recordings/:id/playback')
  playback(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.recordings.playbackUrl(user, id);
  }

  @Get('recordings/:id/download')
  download(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.recordings.downloadUrl(user, id);
  }

  @HttpCode(200)
  @Post('recordings/:id/share')
  share(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: ShareRecordingDto,
  ) {
    return this.recordings.share(user, id, dto.expiresInDays ?? null);
  }

  @HttpCode(200)
  @Post('recordings/:id/unshare')
  unshare(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.recordings.unshare(user, id);
  }

  @Delete('recordings/:id')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.recordings.remove(user, id);
  }

  /**
   * Watch a shared recording. Public by design — the token is the credential,
   * so it is long and unguessable, and can be withdrawn or given an expiry.
   */
  @Public()
  @Get('shared-recordings/:token')
  shared(@Param('token') token: string) {
    return this.recordings.bySharedToken(token);
  }
}
