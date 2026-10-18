import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module";
import { PlatformController } from "./platform.controller";
import { WorkspaceLifecycleService } from "./workspace-lifecycle.service";

/** Every workspace on the platform, for its owners: and each one's life. */
@Module({ imports: [StorageModule], controllers: [PlatformController], providers: [WorkspaceLifecycleService] })
export class PlatformModule {}
