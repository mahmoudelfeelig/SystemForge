import {
  ArrowsLeftRight,
  Cloud,
  Database,
  HardDrives,
  Lightning,
  Queue,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import type { ArchitectureNode } from "@systemforge/contracts";

export const COMPONENT_ICONS: Record<ArchitectureNode["kind"], Icon> = {
  users: UsersThree,
  cdn: Cloud,
  "load-balancer": ArrowsLeftRight,
  api: Lightning,
  cache: HardDrives,
  database: Database,
  queue: Queue,
  worker: HardDrives,
};
