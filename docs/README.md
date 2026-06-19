# Documentation

Reference documentation for `trusted-publisher`. Start with the [project README](../README.md) for
a quick tour, or the [package README](../packages/trusted-publisher/README.md) for the full CLI
reference.

| Document                                                 | What it covers                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                       | The discovery → topology → planning → check → apply pipeline and the module that owns each stage.                                     |
| [detection.md](detection.md)                             | How packages are found and classified, and how publishing workflows are recognized (tools, selectors, matrix, permissions, evidence). |
| [confidence-and-topology.md](confidence-and-topology.md) | Publish topology, workflow selection, permission inference, and the confidence scoring model.                                         |
| [json-report.md](json-report.md)                         | The `--json` report schema, drift format, summary counters, and audit exit codes.                                                     |
| [api.md](api.md)                                         | Programmatic (library) API: discovery, planning, checking, applying, and injecting a custom npm client.                               |
| [positioning.md](positioning.md)                         | Why this tool exists alongside `npm trust`, and its product boundary.                                                                 |
