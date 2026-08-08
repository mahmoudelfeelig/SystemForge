import {
  Archive,
  ArrowsLeftRight,
  Broadcast,
  Cloud,
  Database,
  GlobeHemisphereWest,
  HardDrives,
  Lightning,
  PlugsConnected,
  Queue,
  ShareNetwork,
  TreeStructure,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import type { ArchitectureNode } from "@systemforge/contracts";

export const COMPONENT_ICONS: Record<ArchitectureNode["kind"], Icon> = {
  users: UsersThree,
  region: GlobeHemisphereWest,
  dns: TreeStructure,
  cdn: Cloud,
  network: ShareNetwork,
  "load-balancer": ArrowsLeftRight,
  api: Lightning,
  cache: HardDrives,
  database: Database,
  queue: Queue,
  stream: Broadcast,
  worker: HardDrives,
  "object-store": Archive,
  "third-party": PlugsConnected,
};
