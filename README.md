# Pi Manager

Pi Manager is a local desktop control plane for Pi coding-agent providers,
credentials, model catalogs, thinking-level mappings, and launch profiles.

The project is currently in the product and architecture design phase. The
initial release is planned to support:

- Pi-native subscription and API-key login flows;
- user-defined OpenAI-compatible relay providers;
- one model view for the effective Pi catalog;
- editing the Ctrl+P cycling list and default model;
- model metadata and thinking-level mappings;
- isolated Pi profiles that can be applied, launched, and rolled back.

Pi Manager is intended to work with the official Pi package. It does not fork
Pi or modify a user's project `.pi` directory by default.

See [docs/PRODUCT-DESIGN.md](docs/PRODUCT-DESIGN.md) for the current design
draft, configuration injection model, risks, and proposed acceptance criteria.

See [docs/PRD.md](docs/PRD.md) for the product requirements, user stories,
feature priorities, workflows, and MVP acceptance criteria.

See [docs/PROTOTYPE-SPEC.md](docs/PROTOTYPE-SPEC.md) for the functional
prototype screens, elements, states, interactions, and clickable flows.

## Project status

Design draft. No implementation contract has been accepted yet.

## License

To be decided before the first distributable release.
