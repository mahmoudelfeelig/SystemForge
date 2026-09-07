export type ReferenceStatus = "current" | "evolved" | "historical";
export type ReferenceScope = "whole-system" | "subsystem" | "single-layer";

export interface ReferenceSource {
  label: string;
  publisher: string;
  url: string;
}

export interface SystemDesignReference {
  id: string;
  name: string;
  operator: string;
  publishedSnapshot: string;
  status: ReferenceStatus;
  scope: ReferenceScope;
  domain: string;
  workload: string;
  topology: string[];
  guarantees: string;
  scaleAndFailure: string;
  caveat: string;
  sources: ReferenceSource[];
}

export const SYSTEM_DESIGN_CATALOG: SystemDesignReference[] = [
  {
    id: "amazon-dynamo",
    name: "Dynamo shopping-cart state",
    operator: "Amazon",
    publishedSnapshot: "2007",
    status: "historical",
    scope: "subsystem",
    domain: "Highly available key-value state",
    workload:
      "Latency-sensitive primary-key reads and writes for shopping carts and other always-on services.",
    topology: [
      "Request coordinator",
      "Consistent-hash ring",
      "N preference replicas",
      "Hinted handoff and repair",
    ],
    guarantees:
      "Configurable N/R/W, object versioning, and eventual convergence; availability is favored during partitions.",
    scaleAndFailure:
      "Virtual nodes spread load. Sloppy quorum, hinted handoff, gossip, and Merkle-tree repair handle unreachable replicas.",
    caveat:
      "This is the published Dynamo design, not a claim about current Amazon carts or AWS DynamoDB.",
    sources: [
      {
        label: "Dynamo paper",
        publisher: "Amazon Science",
        url: "https://www.amazon.science/publications/dynamo-amazons-highly-available-key-value-store",
      },
    ],
  },
  {
    id: "google-spanner",
    name: "Spanner global transactions",
    operator: "Google",
    publishedSnapshot: "2012",
    status: "evolved",
    scope: "whole-system",
    domain: "Globally distributed relational database",
    workload:
      "Mission-critical OLTP with consistent snapshot and analytical reads across regions.",
    topology: [
      "Clients",
      "Zones and proxies",
      "Spanservers",
      "Paxos groups",
      "TrueTime",
    ],
    guarantees:
      "Synchronous replication, externally consistent transactions, and lock-free read-only snapshots.",
    scaleAndFailure:
      "Tablets reshard automatically; replica loss is tolerated while a Paxos quorum remains available.",
    caveat: "The operational topology has evolved since the canonical paper.",
    sources: [
      {
        label: "Spanner paper",
        publisher: "Google Research",
        url: "https://research.google/pubs/spanner-googles-globally-distributed-database-2/",
      },
      {
        label: "Spanner, TrueTime and CAP",
        publisher: "Google Research",
        url: "https://research.google/pubs/spanner-truetime-and-the-cap-theorem/",
      },
    ],
  },
  {
    id: "google-bigtable",
    name: "Bigtable wide-column storage",
    operator: "Google",
    publishedSnapshot: "2006",
    status: "evolved",
    scope: "whole-system",
    domain: "Petabyte-scale structured storage",
    workload:
      "Batch indexing and low-latency serving over an ordered, sparse row-key space.",
    topology: [
      "Client library",
      "Master",
      "Tablet servers",
      "Tablets",
      "Replicated file store",
    ],
    guarantees:
      "Ordered rows and atomic operations within one row in the published design.",
    scaleAndFailure:
      "Growing tablets split; failed tablet servers are detected and their ranges reassigned. Row-key locality is decisive.",
    caveat: "Current Cloud Bigtable is not identical to the 2006 architecture.",
    sources: [
      {
        label: "Bigtable paper",
        publisher: "Google Research",
        url: "https://research.google/pubs/bigtable-a-distributed-storage-system-for-structured-data/",
      },
    ],
  },
  {
    id: "google-mapreduce",
    name: "MapReduce batch pipeline",
    operator: "Google",
    publishedSnapshot: "2004",
    status: "historical",
    scope: "whole-system",
    domain: "Large finite batch computation",
    workload:
      "High-throughput map, shuffle, and reduce jobs where completion time matters more than request latency.",
    topology: [
      "Job client",
      "Coordinator",
      "Map workers",
      "Partitioned shuffle",
      "Reduce workers",
      "Distributed files",
    ],
    guarantees:
      "A computation model, not a database consistency model; completed task outputs are committed.",
    scaleAndFailure:
      "Failed tasks are rerun, locality reduces network load, and speculative execution mitigates stragglers.",
    caveat:
      "A canonical historical workload, not Google's complete modern data stack.",
    sources: [
      {
        label: "MapReduce paper",
        publisher: "Google Research",
        url: "https://research.google/pubs/mapreduce-simplified-data-processing-on-large-clusters/",
      },
    ],
  },
  {
    id: "google-borg",
    name: "Borg cluster scheduling",
    operator: "Google",
    publishedSnapshot: "2015",
    status: "evolved",
    scope: "whole-system",
    domain: "Mixed service and batch orchestration",
    workload:
      "Long-running services and batch jobs sharing clusters of tens of thousands of machines.",
    topology: [
      "Job submitter",
      "Replicated Borgmaster",
      "Scheduler",
      "Borglets",
      "Tasks and allocs",
    ],
    guarantees:
      "Declarative desired-state reconciliation; application storage semantics remain outside Borg.",
    scaleAndFailure:
      "Tasks are rescheduled after failure; placement reduces correlated risk while admission and overcommit improve utilization.",
    caveat:
      "The published 2015 architecture is not a complete current Borg specification.",
    sources: [
      {
        label: "Borg paper",
        publisher: "Google Research",
        url: "https://research.google/pubs/large-scale-cluster-management-at-google-with-borg/",
      },
    ],
  },
  {
    id: "meta-tao",
    name: "TAO social graph",
    operator: "Meta",
    publishedSnapshot: "2013",
    status: "evolved",
    scope: "subsystem",
    domain: "Read-dominated graph serving",
    workload:
      "Graph traversals for feeds, likes, comments, pages, and events with sharp object-popularity spikes.",
    topology: [
      "Client API",
      "Follower cache",
      "Leader cache",
      "Sharded MySQL",
      "Primary region per shard",
    ],
    guarantees:
      "Eventual consistency by default, best-effort read-your-write, and optional stronger reads.",
    scaleAndFailure:
      "Cache tiers shield storage; hot shards can be cloned or moved; secondary regions forward writes to the primary.",
    caveat: "Meta's storage fleet has evolved since this TAO publication.",
    sources: [
      {
        label: "TAO: The power of the graph",
        publisher: "Engineering at Meta",
        url: "https://engineering.fb.com/2013/06/25/core-infra/tao-the-power-of-the-graph/",
      },
    ],
  },
  {
    id: "linkedin-kafka",
    name: "Kafka event backbone",
    operator: "LinkedIn",
    publishedSnapshot: "2022–2025",
    status: "current",
    scope: "subsystem",
    domain: "Durable event streaming",
    workload:
      "Activity events, logs, metrics, traces, lake ingestion, stream processing, and database replication.",
    topology: [
      "Producers",
      "Partitioned broker clusters",
      "Consumers",
      "Brooklin mirroring",
      "Cruise Control",
      "Audit",
    ],
    guarantees:
      "Durable replayable ordering per partition; acknowledgements and replication set the trade-off.",
    scaleAndFailure:
      "Partition imbalance, metadata scale, and cross-cluster operations dominate; newer Northguard/Xinfra separates log storage from pub/sub APIs.",
    caveat:
      "The catalog shows the dated Kafka profile and its disclosed evolution, not one timeless topology.",
    sources: [
      {
        label: "Kafka at 7 trillion messages per day",
        publisher: "LinkedIn Engineering",
        url: "https://www.linkedin.com/blog/engineering/open-source/apache-kafka-trillion-messages",
      },
      {
        label: "Northguard and Xinfra",
        publisher: "LinkedIn Engineering",
        url: "https://www.linkedin.com/blog/engineering/infrastructure/introducing-northguard-and-xinfra",
      },
    ],
  },
  {
    id: "linkedin-feed",
    name: "LinkedIn Feed retrieval",
    operator: "LinkedIn",
    publishedSnapshot: "2026",
    status: "current",
    scope: "subsystem",
    domain: "Nearline retrieval and ranking",
    workload:
      "Retrieve and rank millions of posts for more than a billion members with minute-level freshness.",
    topology: [
      "Nearline prompts",
      "Key-value stores",
      "GPU embeddings",
      "ANN index",
      "CPU features",
      "GPU ranker",
    ],
    guarantees:
      "Nearline freshness rather than transactional consistency; disclosed embeddings update within minutes.",
    scaleAndFailure:
      "Batching trades freshness for GPU efficiency; disaggregated CPU and GPU stages isolate their scaling envelopes.",
    caveat:
      "This is the disclosed retrieval and ranking layer, not the complete Feed backend.",
    sources: [
      {
        label: "Next-generation Feed",
        publisher: "LinkedIn Engineering",
        url: "https://www.linkedin.com/blog/engineering/feed/engineering-the-next-generation-of-linkedins-feed",
      },
    ],
  },
  {
    id: "uber-schemaless",
    name: "Schemaless trip storage",
    operator: "Uber",
    publishedSnapshot: "2016",
    status: "evolved",
    scope: "subsystem",
    domain: "Versioned trip records",
    workload:
      "High-volume, mission-critical immutable record versions with secondary lookups and downstream triggers.",
    topology: [
      "Clients",
      "Stateless workers",
      "Storage nodes",
      "Sharded MySQL",
      "Index and trigger lanes",
    ],
    guarantees:
      "Immutable versions and idempotent writes; secondary indexes are eventually consistent.",
    scaleAndFailure:
      "Clients retry another worker safely while workers and storage shards scale independently.",
    caveat:
      "The source establishes the 2016 design, not Uber's exact present trip-store topology.",
    sources: [
      {
        label: "The Architecture of Schemaless",
        publisher: "Uber Engineering",
        url: "https://www.uber.com/ug/en/blog/schemaless-part-two-architecture/",
      },
    ],
  },
  {
    id: "slack-realtime",
    name: "Realtime messaging fanout",
    operator: "Slack",
    publishedSnapshot: "2020",
    status: "evolved",
    scope: "subsystem",
    domain: "WebSocket channel fanout",
    workload:
      "Persistent chat plus transient typing and presence events over tens of millions of connections.",
    topology: [
      "Webapp API",
      "Admin routing",
      "Channel servers",
      "Gateway servers",
      "WebSocket clients",
      "Presence servers",
    ],
    guarantees:
      "The source does not promise exactly-once delivery; transient typing events are explicitly not persisted.",
    scaleAndFailure:
      "Channel servers scale with channel state, gateways with connections, and consistent hashing routes channel ownership.",
    caveat:
      "Persistence internals are outside the disclosed realtime delivery plane.",
    sources: [
      {
        label: "Real-time Messaging",
        publisher: "Slack Engineering",
        url: "https://slack.engineering/real-time-messaging/",
      },
    ],
  },
  {
    id: "discord-messages",
    name: "Message history at trillions",
    operator: "Discord",
    publishedSnapshot: "2023–2025",
    status: "current",
    scope: "subsystem",
    domain: "Write-heavy message history",
    workload:
      "Reverse history scans and sustained writes with heavily skewed channels and event-driven bursts.",
    topology: [
      "API monolith",
      "Rust data services",
      "Request coalescing",
      "ScyllaDB",
      "Channel-time buckets",
      "Local SSD mirrors",
    ],
    guarantees:
      "Current exact consistency settings are not disclosed; predecessor Cassandra used quorum reads and writes.",
    scaleAndFailure:
      "Data services cap duplicate concurrency; time bucketing limits partitions while hot channels remain a first-class risk.",
    caveat:
      "Do not transfer predecessor Cassandra quorum settings to current Scylla without evidence.",
    sources: [
      {
        label: "How Discord Stores Trillions of Messages",
        publisher: "Discord",
        url: "https://discord.com/blog/how-discord-stores-trillions-of-messages",
      },
      {
        label: "Automating ScyllaDB clusters",
        publisher: "Discord",
        url: "https://discord.com/blog/how-discord-automates-scylladb-clusters-at-scale",
      },
    ],
  },
  {
    id: "netflix-open-connect",
    name: "Open Connect video delivery",
    operator: "Netflix",
    publishedSnapshot: "2026",
    status: "current",
    scope: "subsystem",
    domain: "Proactive immutable-media delivery",
    workload:
      "Enormous one-way HTTP delivery of encoded video and image objects with predictable evening peaks.",
    topology: [
      "Playback control plane",
      "Steering",
      "ISP and IXP appliances",
      "Proactive fills",
      "Viewer clients",
    ],
    guarantees:
      "Appliances store no member data and serve immutable files; database consistency does not apply to this layer.",
    scaleAndFailure:
      "Steering avoids unhealthy appliances; content fills and updates mostly run off-peak and appliances can fill peers.",
    caveat:
      "This is the CDN data plane and control plane, not Netflix's complete application architecture.",
    sources: [
      {
        label: "Open Connect overview",
        publisher: "Netflix",
        url: "https://openconnect.netflix.com/Open-Connect-Overview.pdf",
      },
    ],
  },
  {
    id: "dropbox-magic-pocket",
    name: "Magic Pocket block storage",
    operator: "Dropbox",
    publishedSnapshot: "2016",
    status: "evolved",
    scope: "subsystem",
    domain: "Immutable file-content storage",
    workload:
      "Encrypted immutable blocks, hot immediately after upload and progressively colder while retaining low-latency reads.",
    topology: [
      "Frontends",
      "Cross-zone replication",
      "Independent cells",
      "Object devices",
      "Sharded block index",
    ],
    guarantees:
      "Content-addressed immutable blocks, cross-zone replication, and later erasure coding.",
    scaleAndFailure:
      "Cells add capacity, zones isolate disasters, and repair handles disk faults; asynchronous replication exposes a recovery window.",
    caveat:
      "Current cell sizes and replication policy must not be inferred from the 2016 article.",
    sources: [
      {
        label: "Inside the Magic Pocket",
        publisher: "Dropbox Tech",
        url: "https://dropbox.tech/infrastructure/inside-the-magic-pocket",
      },
    ],
  },
  {
    id: "stripe-ledger",
    name: "Money-movement Ledger",
    operator: "Stripe",
    publishedSnapshot: "2024",
    status: "current",
    scope: "subsystem",
    domain: "Financial event reconciliation",
    workload:
      "Billions of transaction events where correctness, timeliness, auditability, and explanation dominate latency.",
    topology: [
      "Producing systems",
      "Immutable event ledger",
      "Transformations",
      "Balance and fund-flow views",
      "Data quality and triage",
    ],
    guarantees:
      "Append-only events, reconstructable prior state, and logical reconciliation across otherwise disconnected systems.",
    scaleAndFailure:
      "Late, malformed, or missing partner data remains explicit and enters alerting and long-tail manual handling.",
    caveat:
      "Stripe does not disclose the physical database or consensus topology, so it is not drawn here.",
    sources: [
      {
        label: "Ledger",
        publisher: "Stripe",
        url: "https://stripe.com/blog/ledger-stripe-system-for-tracking-and-validating-money-movement",
      },
    ],
  },
  {
    id: "github-mysql",
    name: "GitHub relational platform",
    operator: "GitHub",
    publishedSnapshot: "2023–2024",
    status: "current",
    scope: "subsystem",
    domain: "Large relational fleet",
    workload:
      "Repository and collaboration metadata over millions of SQL queries per second.",
    topology: [
      "Application domains",
      "50+ clusters",
      "MySQL primaries",
      "Read replicas",
      "Vitess shards",
      "Orchestrator and migration tooling",
    ],
    guarantees:
      "Primary-based relational consistency; replicas may lag and exact request routing is not public.",
    scaleAndFailure:
      "Vertical domains and Vitess shards spread load; automated failover and reversible mixed-version upgrades constrain risk.",
    caveat:
      "This represents the relational platform, not every GitHub subsystem.",
    sources: [
      {
        label: "Upgrading GitHub.com to MySQL 8.0",
        publisher: "GitHub Engineering",
        url: "https://github.blog/engineering/infrastructure/upgrading-github-com-to-mysql-8-0/",
      },
      {
        label: "MySQL High Availability at GitHub",
        publisher: "GitHub Engineering",
        url: "https://github.blog/engineering/infrastructure/mysql-high-availability-at-github/",
      },
    ],
  },
  {
    id: "shopify-bfcm",
    name: "BFCM checkout and inventory",
    operator: "Shopify",
    publishedSnapshot: "2023–2025",
    status: "current",
    scope: "subsystem",
    domain: "Flash-sale commerce",
    workload:
      "Short-lived browse, cart, checkout, and payment bursts with hot merchants and scarce inventory.",
    topology: [
      "NGINX routing",
      "Storefront Renderer",
      "Shopify Core",
      "ProxySQL and MySQL",
      "Payments, fraud, webhooks",
    ],
    guarantees:
      "Inventory reservation and ledger changes share one ACID MySQL transaction in the disclosed current design.",
    scaleAndFailure:
      "Independent pre-scaling matters; connection counts can overload upstream services before request-rate ceilings are reached.",
    caveat:
      "These are disclosed critical slices, not Shopify's entire production topology.",
    sources: [
      {
        label: "Performance Testing At Scale",
        publisher: "Shopify Engineering",
        url: "https://shopify.engineering/scale-performance-testing",
      },
      {
        label: "Inventory reservations in MySQL",
        publisher: "Shopify Engineering",
        url: "https://shopify.engineering/scaling-inventory-reservations",
      },
    ],
  },
  {
    id: "cloudflare-edge",
    name: "Global edge and DDoS plane",
    operator: "Cloudflare",
    publishedSnapshot: "2024",
    status: "current",
    scope: "subsystem",
    domain: "Anycast ingress, caching, and security",
    workload:
      "Latency-sensitive global HTTP ingress mixed with cached traffic, security inspection, and extreme attack skew.",
    topology: [
      "BGP anycast",
      "ECMP and Unimog",
      "Homogeneous edge servers",
      "Tiered cache",
      "Backbone and origins",
    ],
    guarantees:
      "Cache freshness follows HTTP and purge semantics; the edge is not one strongly consistent global store.",
    scaleAndFailure:
      "Anycast spreads load, traffic management can withdraw routes, and homogeneous servers absorb multiple services.",
    caveat: "No single public diagram represents every Cloudflare product.",
    sources: [
      {
        label: "Cloudflare backbone 2024",
        publisher: "Cloudflare",
        url: "https://blog.cloudflare.com/backbone2024/",
      },
      {
        label: "How BPF powers the edge",
        publisher: "Cloudflare",
        url: "https://blog.cloudflare.com/cloudflare-architecture-and-how-bpf-eats-the-world/",
      },
    ],
  },
  {
    id: "youtube-halp",
    name: "YouTube CDN DRAM cache",
    operator: "Google / YouTube",
    publishedSnapshot: "2023",
    status: "current",
    scope: "single-layer",
    domain: "Learned cache eviction",
    workload:
      "Very high-volume video delivery with large object-size and popularity skew where byte misses dominate.",
    topology: [
      "Viewers",
      "CDN serving cache",
      "HALP DRAM eviction",
      "Deeper storage and network layers",
    ],
    guarantees:
      "Cached immutable video objects; transactional database consistency is outside this layer.",
    scaleAndFailure:
      "Misses fall through to deeper layers; the policy is bounded for low CPU overhead and production noise.",
    caveat:
      "The paper describes one cache layer, not the complete YouTube architecture.",
    sources: [
      {
        label: "HALP eviction policy",
        publisher: "Google Research",
        url: "https://research.google/pubs/halp-heuristic-aided-learned-preference-eviction-policy-for-youtube-content-delivery-network/",
      },
    ],
  },
  {
    id: "airbnb-search",
    name: "Homes embedding retrieval",
    operator: "Airbnb",
    publishedSnapshot: "2025",
    status: "current",
    scope: "subsystem",
    domain: "Approximate search retrieval",
    workload:
      "Millions of listings, broad geography, large candidate sets, and frequent price and availability changes.",
    topology: [
      "Daily listing tower",
      "Listing embeddings",
      "Online query tower",
      "IVF ANN retrieval",
      "Downstream ranking",
    ],
    guarantees:
      "Approximate retrieval; booking inventory remains a separate source of truth.",
    scaleAndFailure:
      "Offline computation reduces online cost while frequent listing changes make index freshness a first-class trade-off.",
    caveat:
      "The article covers retrieval, not the complete search or booking transaction path.",
    sources: [
      {
        label: "Embedding-based retrieval",
        publisher: "Airbnb Engineering",
        url: "https://medium.com/airbnb-engineering/embedding-based-retrieval-for-airbnb-search-aabebfc85839",
      },
    ],
  },
  {
    id: "pinterest-feed",
    name: "Materialized Home Feed",
    operator: "Pinterest",
    publishedSnapshot: "2014–2018",
    status: "historical",
    scope: "subsystem",
    domain: "Personalized feed serving",
    workload:
      "Per-user recommendation from follows and interests, quality-ranked rather than strictly chronological.",
    topology: [
      "Incoming Pins",
      "Smart-feed worker",
      "HBase priority pools",
      "Content generator",
      "Materialized feed service",
    ],
    guarantees:
      "Tracks unseen candidates separately from delivered materialized feed; no database consistency contract is published.",
    scaleAndFailure:
      "If generation fails or times out, the prior materialized feed is served and catches up later.",
    caveat: "A historical reference architecture, not current Pinterest.",
    sources: [
      {
        label: "Building a smarter home feed",
        publisher: "Pinterest Engineering",
        url: "https://medium.com/pinterest-engineering/building-a-smarter-home-feed-ad1918fdfbe3",
      },
    ],
  },
  {
    id: "netflix-control-plane",
    name: "Netflix playback control plane",
    operator: "Netflix",
    publishedSnapshot: "2026",
    status: "current",
    scope: "subsystem",
    domain: "Playback authorization and steering",
    workload:
      "Interactive playback startup, authorization, licensing, metadata, and selection of nearby media appliances.",
    topology: [
      "Client",
      "AWS playback services",
      "Authorization and licensing",
      "Open Connect steering",
      "Selected appliance",
    ],
    guarantees:
      "Control decisions are separate from immutable media delivery and member data is not stored on appliances.",
    scaleAndFailure:
      "Control-plane failure affects starts and steering while already placed media remains on distributed appliances.",
    caveat:
      "Included separately from the data plane so users do not collapse control and delivery into one box.",
    sources: [
      {
        label: "Open Connect overview",
        publisher: "Netflix",
        url: "https://openconnect.netflix.com/Open-Connect-Overview.pdf",
      },
    ],
  },
];
