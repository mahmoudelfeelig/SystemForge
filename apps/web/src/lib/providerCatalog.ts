import { COMPONENT_KINDS, type Architecture } from "@systemforge/contracts";

export interface ProviderSku {
  sku: string;
  name: string;
  componentKinds: string[];
  region: string;
  monthlyEur: number;
  cpuCores?: number;
  memoryGb?: number;
  egressPerGbEur?: number;
}

export interface ProviderCatalog {
  schemaVersion: "1";
  provider: string;
  currency: "EUR";
  retrievedAt: string;
  services: ProviderSku[];
}

const boundedString = (
  value: unknown,
  label: string,
  maximum: number,
): string => {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} must be a non-empty string.`);
  return value.trim().slice(0, maximum);
};

const boundedNumber = (
  value: unknown,
  label: string,
  maximum: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be a finite non-negative number.`);
  return Math.min(maximum, value);
};

export function parseProviderCatalog(input: string): ProviderCatalog {
  if (new Blob([input]).size > 256_000)
    throw new Error("Provider catalog exceeds the 256 KB import limit.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new Error("Provider catalog must be valid JSON.");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("Provider catalog must be a JSON object.");
  const record = decoded as Record<string, unknown>;
  if (record.schemaVersion !== "1")
    throw new Error("Provider catalog schemaVersion must be 1.");
  if (record.currency !== "EUR")
    throw new Error("Provider catalog currency must be EUR.");
  const rawServices = record.services;
  if (!Array.isArray(rawServices) || rawServices.length === 0)
    throw new Error("Provider catalog must contain at least one service.");
  if (rawServices.length > 500)
    throw new Error("Provider catalog cannot contain more than 500 services.");
  const services = rawServices.map((value, index): ProviderSku => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Service ${index + 1} must be an object.`);
    const service = value as Record<string, unknown>;
    if (
      !Array.isArray(service.componentKinds) ||
      !service.componentKinds.length
    )
      throw new Error(`Service ${index + 1} must target component kinds.`);
    const componentKinds = service.componentKinds.map((kind) => {
      if (
        typeof kind !== "string" ||
        !(COMPONENT_KINDS as readonly string[]).includes(kind)
      )
        throw new Error(`Service ${index + 1} has an unknown component kind.`);
      return kind;
    });
    return {
      sku: boundedString(service.sku, `Service ${index + 1} SKU`, 100),
      name: boundedString(service.name, `Service ${index + 1} name`, 120),
      componentKinds,
      region: boundedString(service.region, `Service ${index + 1} region`, 80),
      monthlyEur: boundedNumber(
        service.monthlyEur,
        `Service ${index + 1} monthly price`,
        10_000_000,
      ),
      ...(service.cpuCores === undefined
        ? {}
        : {
            cpuCores: Math.max(
              0.01,
              boundedNumber(
                service.cpuCores,
                `Service ${index + 1} CPU`,
                4_096,
              ),
            ),
          }),
      ...(service.memoryGb === undefined
        ? {}
        : {
            memoryGb: Math.max(
              0.01,
              boundedNumber(
                service.memoryGb,
                `Service ${index + 1} memory`,
                65_536,
              ),
            ),
          }),
      ...(service.egressPerGbEur === undefined
        ? {}
        : {
            egressPerGbEur: boundedNumber(
              service.egressPerGbEur,
              `Service ${index + 1} egress price`,
              10_000,
            ),
          }),
    };
  });
  return {
    schemaVersion: "1",
    provider: boundedString(record.provider, "Provider", 100),
    currency: "EUR",
    retrievedAt: boundedString(record.retrievedAt, "Retrieved date", 40),
    services,
  };
}

export function applyProviderSku(
  architecture: Architecture,
  nodeId: string,
  sku: ProviderSku,
): Architecture {
  const node = architecture.nodes.find((candidate) => candidate.id === nodeId);
  if (!node)
    throw new Error("The selected architecture component no longer exists.");
  if (!sku.componentKinds.includes(node.kind))
    throw new Error(
      `${sku.name} cannot be applied to a ${node.kind} component.`,
    );
  return {
    ...architecture,
    nodes: architecture.nodes.map((candidate) =>
      candidate.id !== nodeId
        ? candidate
        : {
            ...candidate,
            config: {
              ...candidate.config,
              monthlyCostEur: sku.monthlyEur,
              behavior: {
                ...candidate.config.behavior,
                compute: {
                  ...candidate.config.behavior?.compute,
                  ...(sku.cpuCores === undefined
                    ? {}
                    : { cpuCores: sku.cpuCores }),
                  ...(sku.memoryGb === undefined
                    ? {}
                    : { memoryGb: sku.memoryGb }),
                },
                network: {
                  ...candidate.config.behavior?.network,
                  ...(sku.egressPerGbEur === undefined
                    ? {}
                    : { egressCostPerGb: sku.egressPerGbEur }),
                },
                topology: {
                  ...candidate.config.behavior?.topology,
                  region: sku.region,
                },
              },
            },
          },
    ),
  };
}
