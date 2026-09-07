# Pi Manager

Pi Manager is a local desktop control plane for Pi coding-agent providers,
credentials, model catalogs, thinking-level mappings, and launch profiles.

The project is currently moving from the design baseline into implementation.
The first implementation slice supports:

- Pi-native subscription and API-key login flows;
- user-defined OpenAI-compatible relay providers;
- one model view for the effective Pi catalog;
- editing the Ctrl+P cycling list and default model;
- model metadata and thinking-level mappings;
- isolated Pi profiles that can be applied, launched, and rolled back.

The current slice connects the provider card view to the local Manager API. It
can read the persisted provider state and add a custom OpenAI-compatible
provider, including local credential storage. Model policy editing and the
remaining Pi lifecycle flows are still being implemented.

Pi Manager is intended to work with the official Pi package. It does not fork
Pi or modify a user's project `.pi` directory by default.

See [docs/PRODUCT-DESIGN.md](docs/PRODUCT-DESIGN.md) for the current design
draft, configuration injection model, risks, and proposed acceptance criteria.

See [docs/PRD.md](docs/PRD.md) for the product requirements, user stories,
feature priorities, workflows, and MVP acceptance criteria.

See [docs/PROTOTYPE-SPEC.md](docs/PROTOTYPE-SPEC.md) for the functional
prototype screens, elements, states, interactions, and clickable flows.

See [docs/PI-CAPABILITY-MATRIX.md](docs/PI-CAPABILITY-MATRIX.md) for the Pi
runtime facts, verified observations, and pending capability checks.

See [docs/TEST-SCENARIOS.md](docs/TEST-SCENARIOS.md) for executable acceptance
scenarios and evidence requirements.

For the current implementation boundary, see
[docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md).

## Project status

Implementation in progress on the provider state slice; the broader MVP
contract remains governed by the product and prototype documents above.

## License

To be decided before the first distributable release.
