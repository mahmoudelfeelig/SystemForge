import type { ReferenceSource } from "./systemDesignCatalog";

export type IncidentEvidenceKind =
  "operator-postmortem" | "regulator-report" | "government-investigation";

export interface IncidentReference {
  id: string;
  name: string;
  operator: string;
  date: string;
  evidenceKind: IncidentEvidenceKind;
  impact: string;
  trigger: string;
  propagation: string;
  recovery: string;
  preventionLessons: string[];
  componentFamilies: string[];
  sources: ReferenceSource[];
}

const source = (
  label: string,
  publisher: string,
  url: string,
): ReferenceSource => ({ label, publisher, url });

export const INCIDENT_CATALOG: IncidentReference[] = [
  {
    id: "aws-2011-ebs",
    name: "EBS remirroring storm",
    operator: "AWS",
    date: "2011-04-21",
    evidenceKind: "operator-postmortem",
    impact:
      "EBS and dependent EC2/RDS operations failed in one Availability Zone; 0.07% of volumes could not be restored to a consistent state.",
    trigger:
      "An incorrectly executed network traffic shift sent EBS traffic onto a lower-capacity redundant network.",
    propagation:
      "Replica disconnects triggered mass remirroring, exhausted capacity, exposed retry races, and starved control-plane threads.",
    recovery:
      "AWS isolated the cluster, disabled APIs, stopped futile communication, added capacity, and restored recoverable volumes.",
    preventionLessons: [
      "Rate-limit topology changes",
      "Reserve recovery capacity",
      "Isolate control planes by failure domain",
    ],
    componentFamilies: [
      "block storage",
      "replication",
      "network",
      "control plane",
    ],
    sources: [
      source(
        "EBS post-event message",
        "AWS",
        "https://aws.amazon.com/message/65648/",
      ),
    ],
  },
  {
    id: "aws-2015-dynamodb",
    name: "DynamoDB metadata overload",
    operator: "AWS",
    date: "2015-09-20",
    evidenceKind: "operator-postmortem",
    impact:
      "DynamoDB customer errors in us-east-1 stabilized near 55% before recovery.",
    trigger:
      "A brief network disruption interacted with enlarged storage-node membership metadata.",
    propagation:
      "Timed-out nodes disqualified themselves and retried against shared metadata, spreading overload into healthy nodes.",
    recovery:
      "AWS paused membership requests, added metadata capacity, and repaired residual state.",
    preventionLessons: [
      "Bound membership renewal rates",
      "Scale metadata by cardinality",
      "Segment metadata failure domains",
    ],
    componentFamilies: ["database", "metadata", "membership", "retry storm"],
    sources: [
      source(
        "DynamoDB service disruption",
        "AWS",
        "https://aws.amazon.com/message/5467D2/",
      ),
    ],
  },
  {
    id: "aws-2017-s3",
    name: "S3 capacity-removal blast radius",
    operator: "AWS",
    date: "2017-02-28",
    evidenceKind: "operator-postmortem",
    impact:
      "S3 requests and multiple S3-dependent AWS services failed in us-east-1.",
    trigger:
      "An operator entered the wrong input to a capacity-removal command while debugging billing.",
    propagation:
      "Index and placement subsystems fell below safe capacity and needed slow full restarts; the status path also depended on S3.",
    recovery:
      "AWS restored subsystem capacity and restarted index and placement services.",
    preventionLessons: [
      "Enforce hard removal minimums",
      "Execute destructive changes progressively",
      "Keep status infrastructure independent",
    ],
    componentFamilies: [
      "object storage",
      "index",
      "placement",
      "control plane",
      "dependency cascade",
    ],
    sources: [
      source(
        "S3 service disruption",
        "AWS",
        "https://aws.amazon.com/message/41926/",
      ),
    ],
  },
  {
    id: "aws-2020-kinesis",
    name: "Kinesis thread explosion",
    operator: "AWS",
    date: "2020-11-25",
    evidenceKind: "operator-postmortem",
    impact:
      "Kinesis and several Kinesis-backed AWS services failed or degraded in us-east-1.",
    trigger:
      "A modest frontend expansion made every frontend create operating-system threads for every peer.",
    propagation:
      "Thread and memory limits destabilized the fleet while peer-dependent bootstrap made restarts slow.",
    recovery:
      "AWS removed new capacity, changed bootstrap to authoritative metadata, and restarted the fleet carefully.",
    preventionLessons: [
      "Eliminate quadratic peer scaling",
      "Bound process resources",
      "Keep an independent bootstrap path",
    ],
    componentFamilies: [
      "streaming",
      "membership",
      "thread exhaustion",
      "metadata",
    ],
    sources: [
      source(
        "Kinesis service event",
        "AWS",
        "https://aws.amazon.com/message/11201/",
      ),
    ],
  },
  {
    id: "aws-2021-internal-network",
    name: "Internal network connection storm",
    operator: "AWS",
    date: "2021-12-07",
    evidenceKind: "operator-postmortem",
    impact:
      "Many AWS control planes and APIs failed while numerous already-running workloads remained available.",
    trigger:
      "Automated scaling for an internal service produced an unexpected connection surge.",
    propagation:
      "A latent retry/backoff defect sustained device congestion; monitoring and deployment shared the impaired network.",
    recovery:
      "AWS moved DNS, isolated top talkers, disabled heavy traffic, and added network capacity.",
    preventionLessons: [
      "Enforce retry budgets",
      "Protect network devices from connection storms",
      "Move observability out of band",
    ],
    componentFamilies: [
      "internal network",
      "routing",
      "control plane",
      "DNS",
      "observability",
    ],
    sources: [
      source(
        "AWS service event",
        "AWS",
        "https://aws.amazon.com/message/12721/",
      ),
    ],
  },
  {
    id: "aws-2023-lambda-cell",
    name: "Lambda cell-size threshold",
    operator: "AWS",
    date: "2023-06-13",
    evidenceKind: "operator-postmortem",
    impact:
      "Lambda invocations failed, asynchronous queues backed up, and downstream services degraded in us-east-1.",
    trigger:
      "Normal scaling crossed a cell-size threshold never previously reached in production.",
    propagation:
      "A latent frontend defect allocated execution environments but failed to use them, growing backlog and dependency pressure.",
    recovery:
      "AWS scaled the frontend below the threshold and drained the backlog.",
    preventionLessons: [
      "Bound cells to tested sizes",
      "Test scaling thresholds",
      "Rehearse backlog drain recovery",
    ],
    componentFamilies: ["serverless compute", "cells", "autoscaling", "queues"],
    sources: [
      source(
        "Lambda service disruption",
        "AWS",
        "https://aws.amazon.com/message/061323/",
      ),
    ],
  },
  {
    id: "aws-2024-kinesis-shards",
    name: "Kinesis low-throughput shard cardinality",
    operator: "AWS",
    date: "2024-07-30",
    evidenceKind: "operator-postmortem",
    impact:
      "Kinesis and downstream CloudWatch Logs, Firehose, Lambda, Redshift, Glue, ECS, and S3 event paths degraded.",
    trigger:
      "A routine deployment encountered unusually many very-low-throughput shards concentrated on few hosts.",
    propagation:
      "Delayed health messages marked healthy hosts unhealthy, redistributed shards, and overloaded connection provisioning.",
    recovery:
      "AWS shed load, expanded connection capacity, and changed limits.",
    preventionLessons: [
      "Test cardinality separately from throughput",
      "Cap redistribution work",
      "Design explicit load shedding",
    ],
    componentFamilies: ["streaming", "sharding", "health checks", "scheduling"],
    sources: [
      source(
        "Kinesis service event",
        "AWS",
        "https://aws.amazon.com/message/073024/",
      ),
    ],
  },
  {
    id: "aws-2025-dynamodb-dns",
    name: "DynamoDB DNS plan race",
    operator: "AWS",
    date: "2025-10-19",
    evidenceKind: "operator-postmortem",
    impact:
      "DynamoDB regional endpoints lost DNS records and recovery congestion spread into EC2 and other services.",
    trigger:
      "A race between DNS automation actors applied a stale plan and then deleted the active plan.",
    propagation:
      "Lease expiry, recovery congestion, network-manager backlog, and load-balancer health flapping extended the event.",
    recovery:
      "AWS restored DNS manually, throttled and restarted recovery systems, and temporarily disabled automated failover.",
    preventionLessons: [
      "Enforce plan freshness",
      "Put velocity limits on record removal",
      "Scale-test queue-aware recovery",
    ],
    componentFamilies: [
      "DNS",
      "database",
      "leases",
      "network state",
      "load balancing",
    ],
    sources: [
      source(
        "DynamoDB service event",
        "AWS",
        "https://aws.amazon.com/message/101925/",
      ),
    ],
  },
  {
    id: "cf-2012-hk-bgp",
    name: "Hong Kong BGP misadvertisement",
    operator: "Cloudflare",
    date: "2012-05-02",
    evidenceKind: "operator-postmortem",
    impact:
      "About 75% of Cloudflare traffic was affected for at most roughly 15 minutes.",
    trigger:
      "An outbound route configuration was entered on an inbound interface for an offline location.",
    propagation:
      "An upstream accepted and propagated the advertisement, steering global traffic toward the unavailable site.",
    recovery:
      "Cloudflare corrected the advertisements and waited for BGP convergence.",
    preventionLessons: [
      "Validate advertisement direction",
      "Require upstream route filters",
    ],
    componentFamilies: ["BGP", "anycast", "transit routing"],
    sources: [
      source(
        "Today's outage post-mortem",
        "Cloudflare",
        "https://blog.cloudflare.com/todays-outage-post-mortem/",
      ),
    ],
  },
  {
    id: "cf-2012-europe-rate-limit",
    name: "Over-broad DDoS rate limit",
    operator: "Cloudflare",
    date: "2012-09-15",
    evidenceKind: "operator-postmortem",
    impact: "A substantial portion of European traffic became unavailable.",
    trigger:
      "A DDoS rate limit intended for one customer was applied too broadly after upstream trouble concentrated traffic.",
    propagation:
      "The mitigation also affected BGP announcements and forced route rebalancing.",
    recovery: "Cloudflare reverted the limit and routing converged.",
    preventionLessons: [
      "Smoke-test the effective scope of emergency mitigations",
      "Separate filtering from route control",
    ],
    componentFamilies: [
      "DDoS protection",
      "rate limiting",
      "BGP",
      "edge network",
    ],
    sources: [
      source(
        "European outage post-mortem",
        "Cloudflare",
        "https://blog.cloudflare.com/post-mortem-what-todays-network-outage-looked/",
      ),
    ],
  },
  {
    id: "cf-2013-flowspec",
    name: "FlowSpec router crash",
    operator: "Cloudflare",
    date: "2013-03-03",
    evidenceKind: "operator-postmortem",
    impact: "All 23 edge routers crashed and some required physical reboot.",
    trigger:
      "Impossible profiler output generated a FlowSpec range rule that activated a Juniper router defect.",
    propagation:
      "Router memory exhausted across the globally deployed rule scope.",
    recovery: "Cloudflare removed the rule and restarted routers.",
    preventionLessons: [
      "Validate profiler output",
      "Canary generated rules",
      "Keep physical recovery access",
    ],
    componentFamilies: [
      "FlowSpec",
      "router OS",
      "memory exhaustion",
      "DDoS automation",
    ],
    sources: [
      source(
        "FlowSpec outage post-mortem",
        "Cloudflare",
        "https://blog.cloudflare.com/todays-outage-post-mortem-82515/",
      ),
    ],
  },
  {
    id: "cf-2019-verizon-route-leak",
    name: "Verizon route leak",
    operator: "Cloudflare / Verizon",
    date: "2019-06-24",
    evidenceKind: "operator-postmortem",
    impact:
      "Cloudflare and other networks became unreachable from large portions of the Internet.",
    trigger:
      "A small network's BGP optimizer leaked routes that Verizon accepted and propagated.",
    propagation:
      "More-specific paths attracted traffic without adequate filtering or origin validation.",
    recovery: "Networks corrected or withdrew the invalid routes.",
    preventionLessons: [
      "Filter customer routes",
      "Use max-prefix controls",
      "Deploy RPKI origin validation",
    ],
    componentFamilies: ["BGP", "transit", "route leak"],
    sources: [
      source(
        "Verizon route leak analysis",
        "Cloudflare",
        "https://blog.cloudflare.com/how-verizon-and-a-bgp-optimizer-knocked-large-parts-of-the-internet-offline-today/",
      ),
    ],
  },
  {
    id: "cf-2019-waf-regex",
    name: "WAF regex CPU exhaustion",
    operator: "Cloudflare",
    date: "2019-07-02",
    evidenceKind: "operator-postmortem",
    impact:
      "Global 502 responses affected Cloudflare traffic for about 27 minutes.",
    trigger:
      "A WAF rule contained a catastrophic-backtracking regular expression.",
    propagation:
      "WAF rules bypassed gradual rollout and saturated HTTP-serving CPUs globally.",
    recovery:
      "Cloudflare disabled managed rules, rolled back the change, and re-enabled safe rules.",
    preventionLessons: [
      "Performance-test rules",
      "Canary rule rollout",
      "Maintain a global kill switch",
    ],
    componentFamilies: ["WAF", "regex", "CPU", "deployment"],
    sources: [
      source(
        "July 2 outage details",
        "Cloudflare",
        "https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/",
      ),
    ],
  },
  {
    id: "cf-2020-atl-backbone",
    name: "Atlanta backbone route attraction",
    operator: "Cloudflare",
    date: "2020-07-17",
    evidenceKind: "operator-postmortem",
    impact:
      "Traffic dropped by about half across affected geography for 27 minutes.",
    trigger:
      "A one-line router configuration deactivated a prefix-list condition instead of one term.",
    propagation:
      "The router advertised backbone routes with high local preference and attracted widespread traffic into Atlanta.",
    recovery: "Cloudflare disabled the router and restored routing.",
    preventionLessons: [
      "Statically validate configuration meaning",
      "Cap accepted route scope",
      "Protect local-route preference",
    ],
    componentFamilies: [
      "BGP",
      "backbone",
      "traffic engineering",
      "configuration",
    ],
    sources: [
      source(
        "July 17 outage",
        "Cloudflare",
        "https://blog.cloudflare.com/cloudflare-outage-on-july-17-2020/",
      ),
    ],
  },
  {
    id: "cf-2022-clos-config",
    name: "Clos fabric configuration rollout",
    operator: "Cloudflare",
    date: "2022-06-21",
    evidenceKind: "operator-postmortem",
    impact: "Nineteen major data centers were affected in a global outage.",
    trigger:
      "A resilience-project network change reached spine routers across materially different high-traffic sites.",
    propagation:
      "Simultaneous blast radius and engineers overwriting one another's reverts caused recurrence.",
    recovery: "Sites were manually reverted between 06:27 and 07:42 UTC.",
    preventionLessons: [
      "Canary every materially different architecture",
      "Serialize rollback",
      "Make revert state transactional",
    ],
    componentFamilies: [
      "data-center fabric",
      "Clos",
      "routing",
      "deployment coordination",
    ],
    sources: [
      source(
        "June 21 outage",
        "Cloudflare",
        "https://blog.cloudflare.com/cloudflare-outage-on-june-21-2022/",
      ),
    ],
  },
  {
    id: "cf-2023-pdx-power",
    name: "PDX control-plane power failure",
    operator: "Cloudflare",
    date: "2023-11-02",
    evidenceKind: "operator-postmortem",
    impact:
      "Dashboard, APIs, analytics, and logging were impaired while most data-plane traffic continued.",
    trigger:
      "A facility power incident cut all power and exhausted UPS capacity at PDX-04.",
    propagation:
      "Critical control-plane dependencies were concentrated there; DR hit a thundering herd and sequential bootstrap dependencies.",
    recovery:
      "Cloudflare failed over to Europe, rate-limited recovery, and rebuilt the site.",
    preventionLessons: [
      "Enforce HA onboarding",
      "Expose hidden dependencies",
      "Exercise cold disaster recovery",
    ],
    componentFamilies: [
      "power",
      "control plane",
      "analytics",
      "disaster recovery",
    ],
    sources: [
      source(
        "Control plane and analytics outage",
        "Cloudflare",
        "https://blog.cloudflare.com/post-mortem-on-cloudflare-control-plane-and-analytics-outage/",
      ),
    ],
  },
  {
    id: "cf-2024-pdx-power-repeat",
    name: "PDX power failure recurrence",
    operator: "Cloudflare",
    date: "2024-03-26",
    evidenceKind: "operator-postmortem",
    impact:
      "Most control-plane services returned within minutes; analytics recovery still took about ten hours. The data plane remained available.",
    trigger: "The same facility suffered another major power outage.",
    propagation:
      "Analytics remained dependent on the site, but improved failover reduced the earlier control-plane blast radius.",
    recovery:
      "Automated failover restored most services and the site was cold-started.",
    preventionLessons: [
      "Track recurrence as a resilience test",
      "Finish analytics redundancy",
      "Measure cold-start recovery",
    ],
    componentFamilies: [
      "power",
      "disaster recovery",
      "analytics",
      "control plane",
    ],
    sources: [
      source(
        "Code Orange tested",
        "Cloudflare",
        "https://blog.cloudflare.com/major-data-center-power-failure-again-cloudflare-code-orange-tested/",
      ),
    ],
  },
  {
    id: "cf-2024-rate-limiter-loop",
    name: "Rate limiter infinite loop",
    operator: "Cloudflare",
    date: "2024-06-20",
    evidenceKind: "operator-postmortem",
    impact:
      "A 114-minute event peaked at 1.4–2.1% HTTP errors and roughly tripled p99 time to first byte.",
    trigger:
      "A new DDoS rule exposed an infinite loop in a legacy rate limiter.",
    propagation:
      "Poisoned processes, restarts, and monitoring-driven rerouting caused backbone congestion.",
    recovery:
      "Cloudflare restarted processes, disabled the rule, and repaired traffic management.",
    preventionLessons: [
      "Bound rule execution",
      "Retire unsafe runtimes",
      "Test coupled recovery automation",
    ],
    componentFamilies: [
      "DDoS",
      "rate limiting",
      "infinite loop",
      "traffic manager",
      "backbone",
    ],
    sources: [
      source(
        "June 20 incident",
        "Cloudflare",
        "https://blog.cloudflare.com/cloudflare-incident-on-june-20-2024/",
      ),
    ],
  },
  {
    id: "cf-2025-r2-credentials",
    name: "R2 production credential rotation",
    operator: "Cloudflare",
    date: "2025-03-21",
    evidenceKind: "operator-postmortem",
    impact:
      "All writes and about 35% of reads failed globally for 67 minutes, affecting dependent products.",
    trigger:
      "Credential rotation omitted the production environment flag before old production credentials were removed.",
    propagation:
      "Propagation delay hid the break and repeated attempts reused the incorrect environment.",
    recovery: "Correct credentials were deployed to production.",
    preventionLessons: [
      "Make environments type-safe",
      "Verify rotation before revocation",
      "Preserve credential overlap",
    ],
    componentFamilies: ["object storage", "credentials", "CLI", "deployment"],
    sources: [
      source(
        "R2 incident",
        "Cloudflare",
        "https://blog.cloudflare.com/cloudflare-incident-march-21-2025/",
      ),
    ],
  },
  {
    id: "cf-2025-r2-admin-disable",
    name: "R2 production account disabled",
    operator: "Cloudflare",
    date: "2025-02-06",
    evidenceKind: "operator-postmortem",
    impact: "R2 and dependent services failed for 59 minutes.",
    trigger:
      "Abuse remediation mistakenly disabled the production R2 Gateway account.",
    propagation:
      "The unprotected account was the single front door and reversal required lower-level operational access.",
    recovery: "Cloudflare undid the disablement and redeployed the gateway.",
    preventionLessons: [
      "Protect internal accounts systemically",
      "Require two-party destructive authorization",
      "Make admin actions reversible",
    ],
    componentFamilies: [
      "object storage gateway",
      "administration",
      "abuse tooling",
      "dependency cascade",
    ],
    sources: [
      source(
        "February 6 incident",
        "Cloudflare",
        "https://blog.cloudflare.com/cloudflare-incident-on-february-6-2025/",
      ),
    ],
  },
  {
    id: "cf-2025-kv-provider",
    name: "Workers KV central-store dependency",
    operator: "Cloudflare",
    date: "2025-06-12",
    evidenceKind: "operator-postmortem",
    impact:
      "About 90% of KV requests failed during a 2-hour-28-minute global incident; many products inherited the failure.",
    trigger:
      "A third-party storage failure affected KV's central source of truth.",
    propagation:
      "Cold reads and writes failed, then cache repopulation created recovery load and rate limiting.",
    recovery: "The provider restored service and Cloudflare refilled caches.",
    preventionLessons: [
      "Remove single-provider central dependencies",
      "Add independent backends",
      "Load-shape cache recovery",
    ],
    componentFamilies: [
      "KV",
      "central storage",
      "cache",
      "identity",
      "dependency cascade",
    ],
    sources: [
      source(
        "June 12 service outage",
        "Cloudflare",
        "https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/",
      ),
    ],
  },
  {
    id: "gcp-2019-network-config",
    name: "Regional network capacity removal",
    operator: "Google Cloud",
    date: "2019-06-02",
    evidenceKind: "operator-postmortem",
    impact: "Packet loss, latency, and errors affected several US regions.",
    trigger:
      "A configuration intended for a few servers in one region was applied broadly across neighboring regions.",
    propagation:
      "More than half of network capacity disappeared, causing congestion, traffic shedding, and impaired monitoring.",
    recovery: "Google corrected the configuration and restored capacity.",
    preventionLessons: [
      "Mechanically constrain change scope",
      "Guarantee rapid rollback",
      "Isolate monitoring",
    ],
    componentFamilies: [
      "software-defined network",
      "configuration",
      "backbone",
      "capacity",
    ],
    sources: [
      source(
        "Google Cloud incident",
        "Google Cloud",
        "https://status.cloud.google.com/incidents/Nm7HSYZu9RqCY2HXRQQf",
      ),
    ],
  },
  {
    id: "google-2020-auth-quota",
    name: "Global authentication quota collapse",
    operator: "Google",
    date: "2020-12-14",
    evidenceKind: "operator-postmortem",
    impact:
      "Virtually all authenticated Google Cloud and Workspace services were affected.",
    trigger:
      "Automated quota management reduced capacity for Google's central identity system.",
    propagation:
      "The global dependency also impaired operational and status tools; recovery traffic and cached errors prolonged impact.",
    recovery:
      "Google restored identity capacity and absorbed the return surge.",
    preventionLessons: [
      "Guard quota automation",
      "Isolate incident communications",
      "Load-shape recovery",
    ],
    componentFamilies: ["identity", "quota", "control plane", "cache"],
    sources: [
      source(
        "Google authentication incident",
        "Google",
        "https://status.cloud.google.com/incident/zall/20013",
      ),
    ],
  },
  {
    id: "gcp-2021-invalid-route",
    name: "Invalid route router reboot",
    operator: "Google Cloud",
    date: "2021-03-17",
    evidenceKind: "operator-postmortem",
    impact:
      "Multi-region backbone degradation caused packet loss, latency, and endpoint unavailability.",
    trigger:
      "An invalid route activated an unknown defect in a specific router vendor's software.",
    propagation:
      "Affected routers rebooted, reducing backbone capacity while zonal connectivity remained intact.",
    recovery: "Google isolated the route origin and stabilized the routers.",
    preventionLessons: [
      "Validate routes before propagation",
      "Contain vendor-specific control-plane failure",
    ],
    componentFamilies: ["routing", "router OS", "backbone"],
    sources: [
      source(
        "Cloud Networking incident",
        "Google Cloud",
        "https://status.cloud.google.com/incident/cloud-networking/21006",
      ),
    ],
  },
  {
    id: "gcp-2021-gclb-config",
    name: "Load-balancer malformed configuration",
    operator: "Google Cloud",
    date: "2021-11-16",
    evidenceKind: "operator-postmortem",
    impact:
      "Shared frontends returned 404s that propagated into serverless products.",
    trigger:
      "A latent race emitted malformed configuration during a corrective rollout.",
    propagation:
      "A validation patch covered the test manifestation but not the actual malformed form.",
    recovery:
      "Google restored known-good configuration and completed the broader fix.",
    preventionLessons: [
      "Validate invariants, not example errors",
      "Accelerate fixes for latent fleet risk",
    ],
    componentFamilies: [
      "load balancer",
      "configuration distribution",
      "race condition",
      "serverless",
    ],
    sources: [
      source(
        "Cloud Load Balancing incident",
        "Google Cloud",
        "https://status.cloud.google.com/incidents/6PM5mNd43NbMqjCZ5REh",
      ),
    ],
  },
  {
    id: "github-2018-db-partition",
    name: "Cross-region database partition",
    operator: "GitHub",
    date: "2018-10-21",
    evidenceKind: "operator-postmortem",
    impact: "GitHub degraded for 24 hours 11 minutes; no user data was lost.",
    trigger:
      "Replacement of failing optical equipment created a 43-second partition between an East Coast hub and data center.",
    propagation:
      "Orchestrator/Raft elected West Coast primaries while both sides accepted divergent writes, forcing fail-forward restoration and backlog drain.",
    recovery:
      "GitHub restored multi-terabyte databases, rebuilt replication, and drained queued webhooks and Pages work.",
    preventionLessons: [
      "Align consensus with write assumptions",
      "Provide regional serving",
      "Test restore and backlog behavior",
    ],
    componentFamilies: [
      "network partition",
      "MySQL",
      "consensus",
      "failover",
      "queues",
    ],
    sources: [
      source(
        "October 21 post-incident analysis",
        "GitHub",
        "https://github.blog/news-insights/company-news/oct21-post-incident-analysis/",
      ),
    ],
  },
  {
    id: "github-2014-dns",
    name: "Generated DNS zone deletion",
    operator: "GitHub",
    date: "2014-01-08",
    evidenceKind: "operator-postmortem",
    impact:
      "Broad downtime lasted 42 minutes with longer repository-specific effects.",
    trigger:
      "A deployment regenerated zones from a provisioning API that was missing records after coordinated network changes.",
    propagation:
      "DNS failure spawned excess fileserver processes, exhausted memory, and backpressured routing.",
    recovery:
      "GitHub restored records manually and removed unhealthy fileservers.",
    preventionLessons: [
      "Make DNS changes transactional",
      "Validate generated zones",
      "Bound process spawning",
    ],
    componentFamilies: [
      "DNS",
      "provisioning",
      "fileservers",
      "memory",
      "routing",
    ],
    sources: [
      source(
        "DNS outage post-mortem",
        "GitHub",
        "https://github.blog/news-insights/the-library/dns-outage-post-mortem/",
      ),
    ],
  },
  {
    id: "github-2013-code-search",
    name: "Code Search upgrade and recovery",
    operator: "GitHub",
    date: "2013-01-24",
    evidenceKind: "operator-postmortem",
    impact:
      "Code Search experienced repeated outages during upgrade and recovery of a 17 TB cluster.",
    trigger: "Elasticsearch was upgraded without production-scale staging.",
    propagation:
      "Shard corruption, rapid master elections, old Java, and a later Puppet environment mistake complicated recovery.",
    recovery:
      "GitHub rebuilt the cluster with corrected Elasticsearch, Java, and configuration.",
    preventionLessons: [
      "Qualify upgrades at realistic scale",
      "Enforce deployment environment invariants",
      "Rehearse shard recovery",
    ],
    componentFamilies: [
      "search",
      "Elasticsearch",
      "sharding",
      "leader election",
      "configuration",
    ],
    sources: [
      source(
        "Recent Code Search outages",
        "GitHub",
        "https://github.blog/news-insights/recent-code-search-outages/",
      ),
    ],
  },
  {
    id: "github-2012-switch-upgrade",
    name: "Aggregation switch partial failure",
    operator: "GitHub",
    date: "2012-12-22",
    evidenceKind: "operator-postmortem",
    impact:
      "Traffic failed or ran at reduced capacity during an in-service network upgrade.",
    trigger:
      "An aggregation-switch software upgrade encountered vendor agent and MLAG failure behavior.",
    propagation:
      "Redundant peer links stayed active under partial failure and produced an unsafe forwarding state.",
    recovery:
      "GitHub reverted or disabled affected links and coordinated with the vendor.",
    preventionLessons: [
      "Test on exact hardware",
      "Exercise partial control-plane failure",
      "Model MLAG failure states",
    ],
    componentFamilies: ["MLAG", "switching", "high availability", "firmware"],
    sources: [
      source(
        "Downtime last Saturday",
        "GitHub",
        "https://github.blog/news-insights/the-library/downtime-last-saturday/",
      ),
    ],
  },
  {
    id: "github-2012-l2-loop",
    name: "Layer-2 loop and MAC flooding",
    operator: "GitHub",
    date: "2012-11-30",
    evidenceKind: "operator-postmortem",
    impact:
      "GitHub had 18 minutes of complete outage plus intermittent failures.",
    trigger:
      "A migration misconfiguration created a bridge loop while an unsupported watchdog disabled redundant links.",
    propagation:
      "A vendor MAC-learning defect flooded unknown unicast and saturated network links.",
    recovery: "GitHub removed the setting and restarted switch processes.",
    preventionLessons: [
      "Rehearse topology changes",
      "Reject unsupported configuration",
      "Alert on unknown-unicast saturation",
    ],
    componentFamilies: ["layer 2", "MAC learning", "bridge loop", "switching"],
    sources: [
      source(
        "Network problems last Friday",
        "GitHub",
        "https://github.blog/news-insights/the-library/network-problems-last-friday/",
      ),
    ],
  },
  {
    id: "github-2012-db-split-brain",
    name: "Database split brain",
    operator: "GitHub",
    date: "2012-09-11",
    evidenceKind: "operator-postmortem",
    impact:
      "Repository operations degraded while MySQL and Redis identifier state diverged.",
    trigger:
      "Pacemaker segfaulted while leaving maintenance and a partition produced two master-election decisions.",
    propagation:
      "A stale node became active; the separate status site exhausted database connections while autoscaling.",
    recovery:
      "GitHub shut down the stale node, restarted cluster software, restored MySQL, and audited repositories.",
    preventionLessons: [
      "Require authority for primary failover",
      "Test split-brain recovery",
      "Isolate status infrastructure",
    ],
    componentFamilies: [
      "MySQL HA",
      "cluster manager",
      "split brain",
      "Redis",
      "status systems",
    ],
    sources: [
      source(
        "GitHub availability this week",
        "GitHub",
        "https://github.blog/news-insights/the-library/github-availability-this-week/",
      ),
    ],
  },
  {
    id: "github-2020-installation-id",
    name: "Signed 32-bit identifier exhaustion",
    operator: "GitHub",
    date: "2020-05-05",
    evidenceKind: "operator-postmortem",
    impact:
      "GitHub Apps token issuance and dependent Actions, Pages, and Dependabot paths were affected for 2 hours 24 minutes.",
    trigger:
      "A shared table's auto-incrementing identifier reached the signed 32-bit limit.",
    propagation:
      "Every service depending on installation tokens inherited the schema-capacity failure.",
    recovery: "GitHub changed the schema/key capacity and restored issuance.",
    preventionLessons: [
      "Use capacity-safe identifier types",
      "Lint schemas",
      "Alert far ahead of exhaustion",
    ],
    componentFamilies: [
      "relational database",
      "schema capacity",
      "authentication tokens",
    ],
    sources: [
      source(
        "GitHub availability report",
        "GitHub",
        "https://github.blog/news-insights/company-news/introducing-the-github-availability-report/",
      ),
    ],
  },
  {
    id: "gitlab-2017-db-loss",
    name: "Primary database deletion with failed backups",
    operator: "GitLab",
    date: "2017-01-31",
    evidenceKind: "operator-postmortem",
    impact:
      "An approximately 18-hour outage lost six hours of database changes; repositories and wikis remained intact.",
    trigger:
      "During replica repair, an engineer deleted the primary PostgreSQL data directory.",
    propagation:
      "Replication, WAL archival, and dumps had already failed; backup alerts were rejected and restore ownership was unclear.",
    recovery: "GitLab restored an approximately six-hour-old staging snapshot.",
    preventionLessons: [
      "Continuously prove restores",
      "Separate backup failure domains",
      "Make recovery ownership explicit",
    ],
    componentFamilies: ["PostgreSQL", "replication", "backup", "operations"],
    sources: [
      source(
        "Database outage postmortem",
        "GitLab",
        "https://about.gitlab.com/blog/postmortem-of-database-outage-of-january-31/",
      ),
    ],
  },
  {
    id: "meta-2021-backbone",
    name: "Global backbone disconnection",
    operator: "Meta",
    date: "2021-10-04",
    evidenceKind: "operator-postmortem",
    impact:
      "Meta services became globally unreachable and internal operations were severely impaired.",
    trigger:
      "A maintenance command unintentionally removed global backbone connections and an audit-tool defect failed to block it.",
    propagation:
      "Data centers became unreachable, DNS withdrew BGP routes, and out-of-band access was also impaired.",
    recovery:
      "Onsite staff restored the backbone and staged service return to control cold-cache and power surges.",
    preventionLessons: [
      "Bound command blast radius mechanically",
      "Keep DNS and operations independent",
      "Stage cold recovery",
    ],
    componentFamilies: [
      "backbone",
      "BGP",
      "DNS",
      "change control",
      "out-of-band access",
    ],
    sources: [
      source(
        "Outage details",
        "Engineering at Meta",
        "https://engineering.fb.com/2021/10/05/networking-traffic/outage-details/",
      ),
    ],
  },
  {
    id: "fastly-2021-config-trigger",
    name: "Latent CDN defect activated by configuration",
    operator: "Fastly",
    date: "2021-06-08",
    evidenceKind: "operator-postmortem",
    impact:
      "Eighty-five percent of Fastly's network returned errors; 95% of normal service returned within 49 minutes.",
    trigger:
      "A valid customer configuration activated a latent defect in a prior software release.",
    propagation: "The software condition had edge-wide reach.",
    recovery:
      "Fastly disabled the triggering configuration and later deployed a permanent fix.",
    preventionLessons: [
      "Test configuration-trigger combinations",
      "Canary edge software",
      "Limit fleet-wide blast radius",
    ],
    componentFamilies: ["CDN", "edge configuration", "software rollout"],
    sources: [
      source(
        "June 8 outage summary",
        "Fastly",
        "https://www.fastly.com/blog/summary-of-june-8-outage",
      ),
    ],
  },
  {
    id: "atlassian-2022-site-deletion",
    name: "Cloud site hard deletion",
    operator: "Atlassian",
    date: "2022-04-05",
    evidenceKind: "operator-postmortem",
    impact:
      "Atlassian restored 883 sites for 775 customers over as long as 14 days, with at most about five minutes of data loss.",
    trigger:
      "An application-deletion request passed whole-site identifiers to an API that accepted both identifier types without confirmation.",
    propagation:
      "Sites were hard-deleted and restoration tooling only handled one site at a time; support data was also affected.",
    recovery:
      "Atlassian restored sites through a prolonged, largely serial recovery process.",
    preventionLessons: [
      "Use typed destructive APIs",
      "Make deletion soft by default",
      "Exercise bulk restoration",
    ],
    componentFamilies: [
      "administrative API",
      "deletion",
      "SaaS tenancy",
      "disaster recovery",
    ],
    sources: [
      source(
        "April 2022 post-incident review",
        "Atlassian",
        "https://www.atlassian.com/blog/how-we-build/post-incident-review-april-2022-outage",
      ),
    ],
  },
  {
    id: "slack-2021-transit-gateway",
    name: "Transit Gateway and autoscaling feedback",
    operator: "Slack",
    date: "2021-01-04",
    evidenceKind: "operator-postmortem",
    impact:
      "Slack became broadly unavailable after post-holiday traffic returned.",
    trigger: "Traffic growth exceeded how quickly AWS Transit Gateway scaled.",
    propagation:
      "Packet loss saturated web threads; CPU autoscaling initially scaled down, then provisioning hit file-descriptor and quota limits.",
    recovery:
      "Slack disabled scale-down, repaired provisioning, obtained gateway expansion, and used load-balancer panic mode.",
    preventionLessons: [
      "Use multiple scaling signals",
      "Load-test provisioning",
      "Pre-scale shared network infrastructure",
    ],
    componentFamilies: [
      "transit network",
      "web tier",
      "autoscaling",
      "provisioning",
      "observability",
    ],
    sources: [
      source(
        "Slack's January 4 outage",
        "Slack Engineering",
        "https://slack.engineering/slacks-outage-on-january-4th-2021/",
      ),
    ],
  },
  {
    id: "dropbox-2014-db-reinstall",
    name: "Database hosts reinstalled by upgrade automation",
    operator: "Dropbox",
    date: "2014-01-10",
    evidenceKind: "operator-postmortem",
    impact:
      "Most functionality returned within about three hours; core service recovery completed later. User files were not at risk.",
    trigger:
      "An operating-system upgrade script defect reinstalled active database machines.",
    propagation:
      "Some master-replica pairs were both affected and large database restoration was slow.",
    recovery: "Dropbox restored databases from backups.",
    preventionLessons: [
      "Verify host identity before destructive automation",
      "Avoid paired failure domains",
      "Parallelize safe log replay",
    ],
    componentFamilies: ["MySQL", "maintenance automation", "backup"],
    sources: [
      source(
        "Outage post-mortem",
        "Dropbox Tech",
        "https://dropbox.tech/infrastructure/outage-post-mortem",
      ),
    ],
  },
  {
    id: "roblox-2021-consul",
    name: "Consul contention and cold bootstrap",
    operator: "Roblox",
    date: "2021-10-28",
    evidenceKind: "operator-postmortem",
    impact:
      "Roblox was unavailable for 73 hours to roughly 50 million daily users; no user data was lost.",
    trigger:
      "Consul streaming under unusual read/write load caused contention and pathological BoltDB behavior.",
    propagation:
      "One deployment backed discovery, Nomad, Vault, and telemetry; slow Raft leaders and cold caches blocked recovery.",
    recovery:
      "Roblox disabled streaming, stabilized leaders, rebuilt caches and services, and restored traffic gradually.",
    preventionLessons: [
      "Separate coordination domains",
      "Remove observability circularity",
      "Test churn and cold bootstrap",
    ],
    componentFamilies: [
      "Consul",
      "Raft",
      "BoltDB",
      "discovery",
      "secrets",
      "scheduling",
    ],
    sources: [
      source(
        "Return to service",
        "Roblox",
        "https://about.roblox.com/newsroom/2022/01/roblox-return-to-service-10-28-10-31-2021",
      ),
    ],
  },
  {
    id: "datadog-2023-systemd-networkd",
    name: "Cross-region systemd-networkd restart",
    operator: "Datadog",
    date: "2023-03-08",
    evidenceKind: "operator-postmortem",
    impact:
      "More than 60% of nodes disconnected across otherwise isolated multi-cloud regions.",
    trigger:
      "An unattended security update restarted systemd-networkd and Ubuntu flushed foreign IP rules.",
    propagation:
      "The common OS pattern impaired control planes, telemetry, and quorum stores in multiple regions.",
    recovery:
      "Datadog rebuilt or rebooted thousands of nodes in dependency order, prioritizing current ingestion.",
    preventionLessons: [
      "Stage OS changes across failure domains",
      "Keep recovery control out of band",
      "Prioritize live ingest before backfill",
    ],
    componentFamilies: [
      "Linux",
      "systemd",
      "Kubernetes",
      "quorum databases",
      "observability",
    ],
    sources: [
      source(
        "Multi-region connectivity issue",
        "Datadog",
        "https://www.datadoghq.com/blog/2023-03-08-multiregion-infrastructure-connectivity-issue/",
      ),
      source(
        "Platform-level deep dive",
        "Datadog",
        "https://www.datadoghq.com/blog/engineering/2023-03-08-deep-dive-into-platform-level-impact/",
      ),
    ],
  },
  {
    id: "crowdstrike-2024-channel-file",
    name: "Windows sensor channel-file crash",
    operator: "CrowdStrike / Microsoft",
    date: "2024-07-19",
    evidenceKind: "operator-postmortem",
    impact:
      "Microsoft estimated 8.5 million Windows devices were affected and many required boot-level recovery.",
    trigger:
      "A Rapid Response Content update passed through a validation defect and crashed Windows kernels.",
    propagation:
      "Global content distribution amplified the faulty input across Sensor 7.11 and later.",
    recovery:
      "CrowdStrike reverted the channel file and both companies published recovery tooling.",
    preventionLessons: [
      "Canary content like binaries",
      "Strengthen template validation",
      "Make fleet rollback boot-independent",
    ],
    componentFamilies: [
      "endpoint agent",
      "kernel",
      "content pipeline",
      "fleet deployment",
    ],
    sources: [
      source(
        "Channel File 291 RCA",
        "CrowdStrike",
        "https://www.crowdstrike.com/en-us/blog/channel-file-291-rca-available/",
      ),
      source(
        "Helping customers through the outage",
        "Microsoft",
        "https://blogs.microsoft.com/blog/2024/07/20/helping-our-customers-through-the-crowdstrike-outage/",
      ),
    ],
  },
  {
    id: "faa-2023-notam",
    name: "NOTAM database synchronization damage",
    operator: "US FAA",
    date: "2023-01-11",
    evidenceKind: "government-investigation",
    impact: "The FAA issued a nationwide ground stop.",
    trigger:
      "Contractors unintentionally deleted files while correcting primary/backup NOTAM database synchronization.",
    propagation:
      "A damaged database file affected both the primary and backup path.",
    recovery: "The FAA repaired and restored the database.",
    preventionLessons: [
      "Protect repair operations",
      "Prevent backup synchronization from copying corruption",
    ],
    componentFamilies: ["database", "replication", "aviation notices"],
    sources: [
      source(
        "FAA NOTAM statement",
        "Federal Aviation Administration",
        "https://www.faa.gov/newsroom/faa-notam-statement",
      ),
    ],
  },
  {
    id: "rogers-2022-routing",
    name: "BGP redistributed into OSPF",
    operator: "Rogers Communications",
    date: "2022-07-08",
    evidenceKind: "regulator-report",
    impact:
      "More than 12 million customers were affected, including 911 and payment connectivity.",
    trigger:
      "An upgrade removed a routing policy filter from distribution routers.",
    propagation:
      "Full BGP tables entered OSPF, exhausted core-router CPU and memory, and impaired converged services and NOC access.",
    recovery:
      "Rogers restored regions in stages and throttled mobile re-registration.",
    preventionLessons: [
      "Guard protocol redistribution",
      "Separate management communications",
      "Scale-test routing changes",
    ],
    componentFamilies: [
      "BGP",
      "OSPF",
      "core routing",
      "telecom",
      "out-of-band operations",
    ],
    sources: [
      source(
        "Rogers outage report",
        "CRTC",
        "https://crtc.gc.ca/eng/publications/reports/xonarp2023.htm",
      ),
    ],
  },
  {
    id: "tmobile-2020-ims",
    name: "IMS traffic storm",
    operator: "T-Mobile US",
    date: "2020-06-15",
    evidenceKind: "regulator-report",
    impact:
      "Calls and some messaging, including 911 calls, failed nationwide for hours.",
    trigger:
      "A leased fiber-circuit failure in the Southeast propagated into an IP traffic storm.",
    propagation: "The storm overloaded parts of the IMS voice core.",
    recovery:
      "T-Mobile isolated or rerouted traffic and restored core capacity.",
    preventionLessons: [
      "Contain circuit failures before signaling cores",
      "Enforce storm controls",
      "Protect emergency calling independently",
    ],
    componentFamilies: [
      "fiber",
      "IP core",
      "IMS",
      "VoLTE",
      "emergency services",
    ],
    sources: [
      source(
        "T-Mobile outage report",
        "US FCC",
        "https://docs.fcc.gov/public/attachments/DOC-367699A1.pdf",
      ),
    ],
  },
  {
    id: "centurylink-2018-malformed-packets",
    name: "Malformed management-packet propagation",
    operator: "CenturyLink",
    date: "2018-12-27",
    evidenceKind: "regulator-report",
    impact:
      "The nearly 37-hour event affected up to 22 million customers and prevented at least 886 emergency calls.",
    trigger: "Equipment failure combined with network configuration error.",
    propagation:
      "Malformed management packets spread across the fiber network and impaired 911 connectivity.",
    recovery:
      "CenturyLink isolated the faulty behavior and restored transport service.",
    preventionLessons: [
      "Validate management-plane configuration",
      "Contain packet storms",
      "Diversify emergency carrier paths",
    ],
    componentFamilies: [
      "optical transport",
      "management network",
      "telecom",
      "emergency services",
    ],
    sources: [
      source(
        "CenturyLink outage report",
        "US FCC",
        "https://docs.fcc.gov/public/attachments/DOC-359134A1.pdf",
      ),
    ],
  },
  {
    id: "nats-2023-flight-plan",
    name: "Valid flight-plan common-mode failure",
    operator: "UK NATS",
    date: "2023-08-28",
    evidenceKind: "regulator-report",
    impact:
      "Roughly 1,500 flights were cancelled and more than 700,000 passengers were affected.",
    trigger:
      "A valid flight plan with duplicate waypoint identifiers triggered an exception.",
    propagation:
      "Identical software on primary and hot standby created common-mode failure and forced low-capacity manual processing.",
    recovery: "NATS restored service and issued a software correction.",
    preventionLessons: [
      "Use diversity for software fault tolerance",
      "Test adversarial valid inputs",
    ],
    componentFamilies: [
      "parser",
      "safety-critical control",
      "hot standby",
      "common-mode failure",
    ],
    sources: [
      source(
        "NATS incident independent review",
        "UK Civil Aviation Authority",
        "https://www.caa.co.uk/publication/download/23340",
      ),
    ],
  },
  {
    id: "knight-2012-deployment",
    name: "Knight Capital deployment failure",
    operator: "Knight Capital",
    date: "2012-08-01",
    evidenceKind: "regulator-report",
    impact:
      "About four million executions involving 397 million shares produced roughly $460 million in losses in 45 minutes.",
    trigger:
      "New code was omitted from one of eight servers and a reused flag activated dormant defective logic.",
    propagation:
      "No second-person check or aggregate filled-quantity control existed, and 97 error emails were not acted on.",
    recovery: "Knight stopped the code and unwound positions.",
    preventionLessons: [
      "Use immutable verified deployments",
      "Remove dead code",
      "Enforce risk caps and kill switches",
    ],
    componentFamilies: [
      "trading router",
      "deployment",
      "risk controls",
      "alerting",
    ],
    sources: [
      source(
        "SEC order exhibit",
        "US SEC",
        "https://www.sec.gov/Archives/edgar/data/1569391/000119312513401173/d613486dex101.htm",
      ),
    ],
  },
  {
    id: "ariane5-1996-flight501",
    name: "Ariane 5 Flight 501",
    operator: "European Space Agency",
    date: "1996-06-04",
    evidenceKind: "government-investigation",
    impact:
      "The launcher and Cluster satellites were destroyed about 39 seconds after launch.",
    trigger:
      "A numeric conversion overflowed in inertial-reference software reused outside its original operating envelope.",
    propagation:
      "Primary and redundant units ran identical software; diagnostic data was interpreted as attitude data.",
    recovery: "ESA investigated, redesigned, and requalified the system.",
    preventionLessons: [
      "Validate numeric ranges",
      "Test at system level",
      "Recognize common-mode software redundancy",
    ],
    componentFamilies: [
      "embedded software",
      "inertial guidance",
      "numeric conversion",
      "redundancy",
    ],
    sources: [
      source(
        "Ariane 501 inquiry",
        "European Space Agency",
        "https://www.esa.int/Newsroom/Press_Releases/Ariane_501_-_Presentation_of_Inquiry_Board_report",
      ),
    ],
  },
  {
    id: "nasa-1999-mars-climate-orbiter",
    name: "Mars Climate Orbiter unit mismatch",
    operator: "NASA",
    date: "1999-09-23",
    evidenceKind: "government-investigation",
    impact: "The spacecraft was lost during Mars orbit insertion.",
    trigger:
      "Ground software produced impulse values in pound-force seconds while trajectory software expected newton seconds.",
    propagation:
      "Interface, specification, and verification gaps allowed navigation error to accumulate.",
    recovery:
      "NASA investigated the loss and changed mission engineering practices.",
    preventionLessons: [
      "Encode units in types and interfaces",
      "Independently verify navigation and contracts",
    ],
    componentFamilies: [
      "scientific computing",
      "unit conversion",
      "interface contract",
      "navigation",
    ],
    sources: [
      source(
        "Mars Climate Orbiter lesson",
        "NASA",
        "https://llis.nasa.gov/lesson/641",
      ),
      source(
        "MCO Mishap Investigation",
        "NASA",
        "https://discovery.larc.nasa.gov/pdf_files/MCO_report_2.pdf",
      ),
    ],
  },
  {
    id: "patriot-1991-dhahran",
    name: "Patriot long-running clock drift",
    operator: "US Army",
    date: "1991-02-25",
    evidenceKind: "government-investigation",
    impact:
      "The system failed to intercept a Scud missile; 28 US soldiers were killed.",
    trigger:
      "Finite-precision time conversion accumulated error after more than 100 hours of continuous operation.",
    propagation:
      "The accumulated clock error moved the target outside the expected tracking window.",
    recovery:
      "A correction existed but had not reached the deployed battery in time.",
    preventionLessons: [
      "Test long-duration accumulation",
      "Use safe numeric representations",
      "Expedite safety patches",
    ],
    componentFamilies: [
      "real-time clock",
      "numeric precision",
      "tracking",
      "safety-critical software",
    ],
    sources: [
      source(
        "Patriot missile defense",
        "US GAO",
        "https://www.gao.gov/products/imtec-92-26",
      ),
    ],
  },
  {
    id: "blackout-2003-northeast",
    name: "Northeast blackout alarm failure",
    operator: "US and Canadian electric grid",
    date: "2003-08-14",
    evidenceKind: "government-investigation",
    impact: "Approximately 50 million people lost power.",
    trigger:
      "Transmission-line and vegetation events cascaded amid inadequate situational awareness.",
    propagation:
      "The alarm processor stalled, failover copied the stalled state, backup functions failed, and displays slowed severely.",
    recovery: "Grid islands were restored over subsequent hours and days.",
    preventionLessons: [
      "Make alarm failover independent",
      "Exercise degraded operator workflows",
      "Treat observability as a safety system",
    ],
    componentFamilies: ["EMS", "SCADA", "alarms", "failover", "electric grid"],
    sources: [
      source(
        "2003 blackout final report",
        "NERC",
        "https://www.nerc.com/globalassets/our-work/reports/event-reports/august_2003_blackout_final_report.pdf",
      ),
    ],
  },
  {
    id: "flash-crash-2010",
    name: "US market flash crash",
    operator: "US securities markets",
    date: "2010-05-06",
    evidenceKind: "regulator-report",
    impact:
      "The S&P fell roughly 5% in about five minutes and recovered about ten minutes later; individual securities printed extreme prices.",
    trigger:
      "A large automated E-mini futures sell program executed without regard to price or time.",
    propagation:
      "Hot-potato trading, liquidity withdrawal, cross-market transmission, and fragmented data amplified the move.",
    recovery:
      "Markets recovered and regulators later expanded circuit breakers, limit-up/limit-down, and audit measures.",
    preventionLessons: [
      "Make execution price- and rate-aware",
      "Coordinate circuit breakers",
      "Retain complete causal audit data",
    ],
    componentFamilies: [
      "algorithmic trading",
      "liquidity",
      "feedback loop",
      "market data",
    ],
    sources: [
      source(
        "May 6 market events",
        "US SEC",
        "https://www.sec.gov/news/press/2010/2010-81.htm",
      ),
    ],
  },
];
