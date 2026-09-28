# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3](https://github.com/garamahq/bedrock-forge/compare/bedrock-forge-v0.1.2...bedrock-forge-v0.1.3) (2026-06-21)

### Bug Fixes

- deploy GitHub catalog extensions atomically without running site Composer
- restore themes when Composer-managed plugin operations alter theme files
- synchronize management networks with fail2ban hardening

## [0.1.2](https://github.com/garamahq/bedrock-forge/compare/bedrock-forge-v0.1.1...bedrock-forge-v0.1.2) (2026-06-21)

### Bug Fixes

- preserve unrelated themes and locked packages during custom plugin operations
- synchronize Forge management IP allowlists into WP Secure Guard

## [0.1.1](https://github.com/garamahq/bedrock-forge/compare/bedrock-forge-v0.1.0...bedrock-forge-v0.1.1) (2026-04-16)

### Features

- add CDN and image optimization features ([529c443](https://github.com/garamahq/bedrock-forge/commit/529c44372a7ef96c8963c25910d2633a4a7811fa))
- add database and cache management tools ([d299126](https://github.com/garamahq/bedrock-forge/commit/d29912637f9f3b4e35cfa82e5934073e35e6bef3))
- add package infrastructure and dependencies ([a365386](https://github.com/garamahq/bedrock-forge/commit/a3653864d74eebca680cfbbe625be003375362a5))
- add performance testing and optimization suite ([56a2d1a](https://github.com/garamahq/bedrock-forge/commit/56a2d1ac3a9cd88fbf076c61bf0b34b8fbaca977))
- add real-time performance monitoring and alerting ([492523f](https://github.com/garamahq/bedrock-forge/commit/492523f4aad5f018869b307b5dd0364f12b96af1))
- add Release Please for automated releases and GitHub Actions ([df4ccfb](https://github.com/garamahq/bedrock-forge/commit/df4ccfb334d437bf651fb6ef49a63531160fdbba))
- **api/dashboard:** extract DashboardRepository, expand health controller ([b104995](https://github.com/garamahq/bedrock-forge/commit/b104995b95bb11650d5949877ea42491bcb7fa9b))
- **api/sync:** add skipSafetyBackup option to clone endpoint ([d21675b](https://github.com/garamahq/bedrock-forge/commit/d21675baff031c27438dad81602448e14cbe56ab))
- **api/worker:** detect CyberPanel version via SSH; MySQL CLI fallback for DB creation ([f5847ac](https://github.com/garamahq/bedrock-forge/commit/f5847ac19a23e7ef9679d05ade1ee660ee9dc3c2))
- **api:** add audit-logs CRUD module ([4eb1ee0](https://github.com/garamahq/bedrock-forge/commit/4eb1ee08f23a77d294a692a1481ae9b39a8f3f9e))
- **api:** add backup retention policy to schedules and improve backup endpoints ([5a46aea](https://github.com/garamahq/bedrock-forge/commit/5a46aeaa135a62847297cedcf3ef437f2559cbeb))
- **api:** add dedicated dashboard stats module ([902336e](https://github.com/garamahq/bedrock-forge/commit/902336eda1dba9d3c1d998a9e6eb38c791b386bb))
- **api:** add dry-run mode and improved error handling to sync module ([7c6889d](https://github.com/garamahq/bedrock-forge/commit/7c6889dd523290745b474ec6b650415622fbaf57))
- **api:** add full project create flow with CyberPanel provisioning and enriched project DTO ([304293e](https://github.com/garamahq/bedrock-forge/commit/304293e79993f89a0c46a67cd5e60e3a3f24cb70))
- **api:** add helmet, audit interceptor, nightly maintenance, and reports modules ([7eccabc](https://github.com/garamahq/bedrock-forge/commit/7eccabce3f6b9f1ee987f3e6c4c619c601bc01e4))
- **api:** add plugin install/remove/update and change-constraint management endpoints ([f863486](https://github.com/garamahq/bedrock-forge/commit/f86348624922b43c1b0a9a13aecff1745ba29d08))
- **api:** add users, packages, invoices, and notifications modules ([249c664](https://github.com/garamahq/bedrock-forge/commit/249c6640a120cf88ffa719cd150188cbcb40de46))
- **api:** bootstrap NestJS app with auth, health, and WebSocket ([9c10c08](https://github.com/garamahq/bedrock-forge/commit/9c10c0853592ee9bf08b89dd9d9149be1b28881d))
- **api:** expand backups, analytics, and migrations ([1c54300](https://github.com/garamahq/bedrock-forge/commit/1c54300734f8853d32b12be466931e1844fa305a))
- **api:** extend cyberpanel service with website and database provisioning operations ([fe5242e](https://github.com/garamahq/bedrock-forge/commit/fe5242e6d884956acfd65e53f196619051f61e00))
- **api:** implement domain modules with repository pattern ([5960f08](https://github.com/garamahq/bedrock-forge/commit/5960f0858dc40f2967564a2b9f83773d47b9d863))
- **api:** improve invoices with advanced filtering, bulk operations, and enriched DTO ([1c1b7eb](https://github.com/garamahq/bedrock-forge/commit/1c1b7eb17ef6ae338e3a6f53eb63e46448771b36))
- **api:** improve jobs gateway room broadcasting and auth controller ([596bef8](https://github.com/garamahq/bedrock-forge/commit/596bef8a857953036a9f21d00521d64d04b502f9))
- **api:** include latest create-bedrock job execution in environments response ([3d35b76](https://github.com/garamahq/bedrock-forge/commit/3d35b76810f12448133b0da13f14986651e0a8d7))
- **api:** propagate job_type on executions; add job_type and environment_ids filters ([2b79f3b](https://github.com/garamahq/bedrock-forge/commit/2b79f3baaf1e8f1cd7f0a7eff4b6fdbd9e0e7b4a))
- **api:** register DashboardModule and AuditLogsModule; add global HTTP exception filter ([12693f6](https://github.com/garamahq/bedrock-forge/commit/12693f6795e905f57f523aa07debbcdfffbaa5cd))
- **api:** update API server integrations and core utilities ([f6a8d5b](https://github.com/garamahq/bedrock-forge/commit/f6a8d5bc840e5aa400c55c2a7d500f53cfe5566e))
- **api:** update routes and services ([f8e5b78](https://github.com/garamahq/bedrock-forge/commit/f8e5b78dcba0e316a4daafbce27ea1db3b99c388))
- **auth:** add PUT /auth/change-password endpoint ([4bdb07c](https://github.com/garamahq/bedrock-forge/commit/4bdb07ccdb31701b4aa4d330bee95452d912437d))
- **ci:** add GitHub Actions CI workflow ([5beda98](https://github.com/garamahq/bedrock-forge/commit/5beda98732dce65d166e3afbc4d6539ff1aa374b))
- **ci:** add Jenkins and Kuma integration scripts ([135c840](https://github.com/garamahq/bedrock-forge/commit/135c84086dadf927480006576555eec90e5d496a))
- **ci:** automate Jenkins pipeline registration and Kuma monitor integration ([9eafa17](https://github.com/garamahq/bedrock-forge/commit/9eafa175f6f6fac2210f9fb675109d2e25656ccb))
- **cli:** update CLI commands for deploy, performance, sync, and workflows ([777fe78](https://github.com/garamahq/bedrock-forge/commit/777fe7820b114371bc8a7241f33569654927628f))
- complete all major phases ([687012b](https://github.com/garamahq/bedrock-forge/commit/687012b5b0ae375397304b20fa0cda849b83cd1d))
- **dashboard-services:** align frontend API layer and env wiring ([9c4377e](https://github.com/garamahq/bedrock-forge/commit/9c4377ed25a3b9c030df10e6a014d225647c36c6))
- **dashboard:** centralize runtime env config and build wiring ([652abb1](https://github.com/garamahq/bedrock-forge/commit/652abb1cba24d602e403aa4ed86465dcd7ad1530))
- **dashboard:** expand pages and UI ([338a1c9](https://github.com/garamahq/bedrock-forge/commit/338a1c92a6f91ef5b172e7faf8879e862af7a2f2))
- **dashboard:** migrate page and component structure ([4e595d4](https://github.com/garamahq/bedrock-forge/commit/4e595d4a5ed72e14cde3c792a4f703f848e79d26))
- **dashboard:** migrate ui primitives and navigation structure ([1c71562](https://github.com/garamahq/bedrock-forge/commit/1c715623dad2b08b456483e7dbc6b469aac122ff))
- **dashboard:** update api clients and types ([5966a46](https://github.com/garamahq/bedrock-forge/commit/5966a469e11597b58e6d6c427cdb06ac64bb002b))
- **dashboard:** update pages and UI ([560ef94](https://github.com/garamahq/bedrock-forge/commit/560ef9441105ff62c7cd927ca13c8654b844bf82))
- **db:** expand Prisma schema to full 26-table domain model ([ffa106d](https://github.com/garamahq/bedrock-forge/commit/ffa106dca56358996d6356267083446cd7db38bf))
- **ddev:** make the flow use ddev where possible to simplify it all ([f17e9b6](https://github.com/garamahq/bedrock-forge/commit/f17e9b653a0549313c09c53ff19db1523b21f1b7))
- **deploy:** add deploy.sh, harden install.sh and update.sh for production ([7fd9133](https://github.com/garamahq/bedrock-forge/commit/7fd9133977f064454c435c7d1cf45d4323a8c0eb))
- **deploy:** modularize deployment script ([26c6d44](https://github.com/garamahq/bedrock-forge/commit/26c6d444f3242254e9790a5d50f44a65e937c339))
- **dns:** automate DNS with Cloudflare CLI and update docs ([0c289e6](https://github.com/garamahq/bedrock-forge/commit/0c289e61dd0d2694caf06c295e6e18d5e12044b3))
- enhance CLI commands with new functionality ([c819703](https://github.com/garamahq/bedrock-forge/commit/c819703318fafe0920e4860ce0e4d21613c00a91))
- implement comprehensive analytics and business intelligence suite ([dabf3c5](https://github.com/garamahq/bedrock-forge/commit/dabf3c57cbc5f303fdf4f710e624714e20dcdc2f))
- implement comprehensive dashboard system for ManageWP replacement ([18a548e](https://github.com/garamahq/bedrock-forge/commit/18a548e8477befa3eef8789c9bb9a0a32a2978ab))
- implement comprehensive installation system ([e2ccf59](https://github.com/garamahq/bedrock-forge/commit/e2ccf59a1dd7ee6dd49693c86b6f533198f85792))
- implement comprehensive plugin management system ([c275bee](https://github.com/garamahq/bedrock-forge/commit/c275beec90697f7bdae3fd7dfa78b50bd5937a83))
- implement configuration management and core constants ([6c1c149](https://github.com/garamahq/bedrock-forge/commit/6c1c149c423f3d420b1e7b858b324767b6019a57))
- implement phase 1, 2 ([182a6f3](https://github.com/garamahq/bedrock-forge/commit/182a6f3fe823f8c5996721ac3e99f894961e7829))
- implement phase 4 ([eecd58e](https://github.com/garamahq/bedrock-forge/commit/eecd58ebd1114d2252eb9f403956526b4c8eade2))
- improve configuration and project creation workflow ([2000bc1](https://github.com/garamahq/bedrock-forge/commit/2000bc12362515d79633e0c86bcf54d27b51892c))
- **local:** automate git repo init and push for new sites ([9f43316](https://github.com/garamahq/bedrock-forge/commit/9f43316170c13a457e13061f0f52d2c0d7b2e5d8))
- **local:** automate GitHub repo creation via API ([ab9fbe3](https://github.com/garamahq/bedrock-forge/commit/ab9fbe38611638adc42b8b3da04da276d89b9efe))
- **local:** automate secure .env file generation for sites ([538ad0c](https://github.com/garamahq/bedrock-forge/commit/538ad0cf40710f4d32cf65ff5055194f47dc1f90))
- **local:** migrate site creation logic to modular script ([db55302](https://github.com/garamahq/bedrock-forge/commit/db553025a451843be030c7f161cc0fc5f0488a18))
- **local:** modularize environment switching script ([1ac3419](https://github.com/garamahq/bedrock-forge/commit/1ac341955ce8cbacf3600e6142dbb7ef85b3f8f5))
- **monitors:** add log history and paginated results endpoints ([f5e95e7](https://github.com/garamahq/bedrock-forge/commit/f5e95e79431e22c5b9c8b4dd3f5d7a45169d6af2))
- **nest-api:** add background runners and stabilize module contracts ([025d0b8](https://github.com/garamahq/bedrock-forge/commit/025d0b845dbd7b26c285ae1b33c12f80eda930fa))
- **nest-api:** add domain APIs, task-status, and websocket compatibility ([9ebaac5](https://github.com/garamahq/bedrock-forge/commit/9ebaac5988eda194dffb8c7020779a64ed48f19d))
- **nest-api:** scaffold service runtime and build tooling ([a8fc9a2](https://github.com/garamahq/bedrock-forge/commit/a8fc9a2adc578c7acece76e606b7ffe14ea55dd1))
- **packages:** add shared types/queues and remote-executor library ([99018d7](https://github.com/garamahq/bedrock-forge/commit/99018d795944002e83428bdffd1ea3b17f05738a))
- **prisma:** add MonitorLog model with state-transition tracking ([1f566dd](https://github.com/garamahq/bedrock-forge/commit/1f566dd52976c7d1545b7443655c8829758381a9))
- **projects:** support optional custom DB credentials in project creation ([83bda5c](https://github.com/garamahq/bedrock-forge/commit/83bda5c25759dc4026c7409308b3a4a29ad9de7a))
- **provision:** automate DNS propagation verification for A/CNAME records ([209ab78](https://github.com/garamahq/bedrock-forge/commit/209ab785ff11f9e4910c07c534eb500050c8a146))
- **provision:** automate Hetzner server creation via API ([9fd2585](https://github.com/garamahq/bedrock-forge/commit/9fd2585a0607bec527fb14f6fd3f13965970dbae))
- **provision:** automate Hetzner server hardening (firewall, fail2ban, updates, SSH) ([7aea0b6](https://github.com/garamahq/bedrock-forge/commit/7aea0b65847eb9516ed022d95f9abc13dc128f44))
- **provision:** automate logrotate installation and config for logs directory ([8457ea3](https://github.com/garamahq/bedrock-forge/commit/8457ea33ec41d571b789b99071a6e4a68e0bd6d4))
- **provision:** automate rclone install and config upload on remote server ([c4e8e09](https://github.com/garamahq/bedrock-forge/commit/c4e8e09c8084bdd6634e788c4be4efc2f4dfce9e))
- **provision:** automate SSH key generation and remote setup ([f8363fe](https://github.com/garamahq/bedrock-forge/commit/f8363feee379f6d8a60839135331fccefe7e6991))
- **provision:** collect and store project info after provisioning ([6a6e8d7](https://github.com/garamahq/bedrock-forge/commit/6a6e8d7f16802f568054299d3364c011bf573f4f))
- **provision:** fully automate rclone config and upload for Google Drive ([d7849b9](https://github.com/garamahq/bedrock-forge/commit/d7849b9d282e095c21c000b18234de082a8a8012))
- **provision:** interactive Hetzner provisioning with hcloud context/token setup and improved docs ([1ccbb2a](https://github.com/garamahq/bedrock-forge/commit/1ccbb2a30ddc033f4e178a7c61fe491db84cc5b4))
- **provision:** modularize CyberPanel provisioning ([bdfa5d2](https://github.com/garamahq/bedrock-forge/commit/bdfa5d2d5a24dd90db4908f1503f3213d292d8ba))
- **provision:** store and display Hetzner server info in project ([35c5e08](https://github.com/garamahq/bedrock-forge/commit/35c5e088d288163cbd95b59606403f0372f82a1f))
- **provision:** support selecting existing Hetzner server for site creation ([f7cb769](https://github.com/garamahq/bedrock-forge/commit/f7cb7698ecd59cfdae37a66a5263d6e13c425b81))
- reinit project cli with python ([d83d7bd](https://github.com/garamahq/bedrock-forge/commit/d83d7bda1044889b46876288944dc2a4e24c83ef))
- reports management page (/reports) ([7fddd6f](https://github.com/garamahq/bedrock-forge/commit/7fddd6fbea8a9cc9cfec31a35307a16703d47be1))
- **reports:** inline channel subscription control + schedule period + gap fixes ([7662db2](https://github.com/garamahq/bedrock-forge/commit/7662db28b8b3e1c2274e208e41b25eb83f3b310b))
- rewrite entire project ([74ba073](https://github.com/garamahq/bedrock-forge/commit/74ba073e0f38a3ef7f3bfb89d21cf90e17d0ab33))
- **shared:** add reports queue, plugin-manage job type, and create-bedrock cyberpanel payload types ([190964a](https://github.com/garamahq/bedrock-forge/commit/190964a76b80fc6ba15094a9bd8cf647aa3764f7))
- **site-init:** add parent directory support for project creation ([7418086](https://github.com/garamahq/bedrock-forge/commit/7418086d5e987aec68f1e91b041b472c014c51f2))
- **site-init:** copy support scripts into new project ([1b89296](https://github.com/garamahq/bedrock-forge/commit/1b8929627d6d92cb331b50ef8d89b18e02c6c3eb))
- **site-init:** per-site DB/user and isolated compose/env ([704c86c](https://github.com/garamahq/bedrock-forge/commit/704c86c2ba58383b50e6c665fb3c72677d35a838))
- **sync:** add rclone GUI launcher ([600305d](https://github.com/garamahq/bedrock-forge/commit/600305df24a1d3cebff1dc55274801bb7b8e9ede))
- **sync:** implement backup and restore automation with retention policy ([8305d71](https://github.com/garamahq/bedrock-forge/commit/8305d71f515ae044ec4e6574eb97d39ba9e0193c))
- **sync:** modularize db/uploads sync scripts ([159eaa1](https://github.com/garamahq/bedrock-forge/commit/159eaa1dc04ed6f828a926e7f1c7b7d05d4c50de))
- **ui:** update dashboard UI and client pages ([820e2ab](https://github.com/garamahq/bedrock-forge/commit/820e2abd727de86839ef4bc8b7f153be66d9b3af))
- update CLI core with version management and documentation ([034f26a](https://github.com/garamahq/bedrock-forge/commit/034f26ad8aaa1f694ca2839c1fa85c797b64d39d))
- use ddev for local site dev ([824b786](https://github.com/garamahq/bedrock-forge/commit/824b7865651f7444fcb505566d7bbf4c5be45984))
- **web/sync:** add sync history panel with live log expansion ([d77624c](https://github.com/garamahq/bedrock-forge/commit/d77624c6ab62d7931fb0e728ebf89585867bd490))
- **web:** add AuditLogs, ClientDetail, Domains, and MonitorDetail pages ([8198261](https://github.com/garamahq/bedrock-forge/commit/8198261ad2e7a595d57953a5826d1ef28e4c2708))
- **web:** add backup retention configuration to BackupsTab, improve RestoreTab UX ([b84ed27](https://github.com/garamahq/bedrock-forge/commit/b84ed27727930df4a757ff1528f3dab646b2a74d))
- **web:** add change-password section in SettingsPage ([2dde3a7](https://github.com/garamahq/bedrock-forge/commit/2dde3a72ff57fc87529a97bb327c7657d2fcec02))
- **web:** add CommandPalette and Stepper UI components ([6f7ae3c](https://github.com/garamahq/bedrock-forge/commit/6f7ae3cfdb2be06b8e1554c9d48df2aff4b8d51a))
- **web:** add CreateBedrockDialog and update app routing with new pages ([3838750](https://github.com/garamahq/bedrock-forge/commit/3838750fa4d3a82905d305ab26c3fae6b8b05bae))
- **web:** add execution logs to CreateBedrock dialog; fix domain expiry badge colors ([b4763f2](https://github.com/garamahq/bedrock-forge/commit/b4763f28c35cf81b859cf4af43097e52c5a38ccc))
- **web:** add NotFoundPage and reusable data hooks ([26bcfb8](https://github.com/garamahq/bedrock-forge/commit/26bcfb857be5685f5a299704b72173099f1e50f7))
- **web:** extend API client and websocket with new endpoints, improve DataTable UX ([358c2cd](https://github.com/garamahq/bedrock-forge/commit/358c2cdd31239899fd14a2017caed6478b153c8f))
- **web:** implement React frontend with full feature coverage ([6cc6687](https://github.com/garamahq/bedrock-forge/commit/6cc668786a290bc5668e723126a8f90cd31143ca))
- **web:** overhaul PluginsTab with install/remove/update/constraint management and live job logs ([ac38f6e](https://github.com/garamahq/bedrock-forge/commit/ac38f6e6a2b620883df49e03d6c3cde98a6c1356))
- **web:** overhaul SyncTab with dry-run mode, conflict detection, and structured live logs ([fc426de](https://github.com/garamahq/bedrock-forge/commit/fc426de6472d722a2482a81c75b2696632c68146))
- **web:** rebuild InvoicesPage with advanced filtering, grouping, and bulk status management ([4fa2ef7](https://github.com/garamahq/bedrock-forge/commit/4fa2ef7c4f76d9f9877ab6c942db0bd08987771e))
- **web:** redesign CreateBedrockDialog as multi-step wizard ([3c3ec7d](https://github.com/garamahq/bedrock-forge/commit/3c3ec7dd15316e9c2fd66d161d754cc39cd44ea0))
- **web:** redesign DashboardPage with live stats and activity feed ([927169d](https://github.com/garamahq/bedrock-forge/commit/927169d04fafb9fafdc21f0f96aa0e3ade1d197e))
- **web:** restore history panel; dev login quick-fill button ([a92817d](https://github.com/garamahq/bedrock-forge/commit/a92817d5eaf34e4f17c1cec5d4406c197cc1a378))
- **web:** show provisioning status on environment cards with real-time updates ([9036271](https://github.com/garamahq/bedrock-forge/commit/903627169d91719e60acb32846f000e110e4c6e5))
- **web:** update ProjectsPage, ServersPage, and SettingsPage with new features and UI polish ([b07c643](https://github.com/garamahq/bedrock-forge/commit/b07c643c58054267477c0477ed68ee34f8386d28))
- **web:** update routing, layout and navigation for new pages ([1dd4bde](https://github.com/garamahq/bedrock-forge/commit/1dd4bdecfc5e07b590ecae7368634735b8d337b8))
- **worker/monitors:** record up/down/degraded state transitions in MonitorLog ([892c785](https://github.com/garamahq/bedrock-forge/commit/892c785d0265658e83a95bf26915c19707eca870))
- **worker/sync:** stored creds, --defaults-extra-file, skipSafetyBackup, robust URL search-replace ([d3a2004](https://github.com/garamahq/bedrock-forge/commit/d3a200441529a207bfda836c72b246371a593e1f))
- **worker:** add cyberpanel HTTP util, composer manager script, and report processor ([70267e2](https://github.com/garamahq/bedrock-forge/commit/70267e2c3ae51e10ef75a6a3ec1226add3606275))
- **worker:** confirmation retry, degraded detection, report activity tracking ([ada9657](https://github.com/garamahq/bedrock-forge/commit/ada9657abd0dff73816b7729cbbd839bc97d3e91))
- **worker:** extend create-bedrock processor with CyberPanel provisioning and environment clone support ([9e96c1d](https://github.com/garamahq/bedrock-forge/commit/9e96c1d5296a9593db3f4a8327d8f27eb9028b81))
- **worker:** extend plugin-scan processor with composer-based plugin management actions ([7270e24](https://github.com/garamahq/bedrock-forge/commit/7270e244773f691262d79749c268cc11939f367e))
- **worker:** implement all BullMQ processors and services ([99685b8](https://github.com/garamahq/bedrock-forge/commit/99685b8334f38d2862c35ba4a98a22187fb1efd3))
- **worker:** improve sync processor with dry-run mode, enforce backup retention policy, update monitor processor ([c9cc169](https://github.com/garamahq/bedrock-forge/commit/c9cc169f15db92ece35f82d091d55329d2e77900))

### Bug Fixes

- add agents folder ([34dcde4](https://github.com/garamahq/bedrock-forge/commit/34dcde4b26083096fab3c1156a79b2295da6a990))
- add missing /reports route to App.tsx ([26a501a](https://github.com/garamahq/bedrock-forge/commit/26a501a43d80dc53bd30cf92c0fe1afe996cc473))
- **api/backup-schedules:** use rj.id for repeatable job removal in BullMQ v5 ([4b6cb3f](https://github.com/garamahq/bedrock-forge/commit/4b6cb3f0b4742037a71f9d2a45e02faa849a5348))
- **api:** audit-logs, auth, invoices, job-executions improvements ([4af8d73](https://github.com/garamahq/bedrock-forge/commit/4af8d73b3df469a009bb59a3369791eb02a7bee8))
- **api:** extract registrable root domain when auto-creating domain records ([39e2c54](https://github.com/garamahq/bedrock-forge/commit/39e2c54ad396476f7a1c6c6be4035f078225ec09))
- **api:** harden startup migrations and admin utility flows ([6ce3d3c](https://github.com/garamahq/bedrock-forge/commit/6ce3d3c83114550ed8f345d960b55860e982aaa2))
- **api:** persist server status to db after ssh connection test ([7cc3495](https://github.com/garamahq/bedrock-forge/commit/7cc34950dff74dfaf875cce79c47994ba409c20f))
- **api:** production startup validation and CORS hardening ([9e3a0c7](https://github.com/garamahq/bedrock-forge/commit/9e3a0c7b03f9e7884b3b787c8c5ff78d5b8fda76))
- **api:** RBAC on backup schedules, resilient maintenance, domain project relation ([8c7cd83](https://github.com/garamahq/bedrock-forge/commit/8c7cd83e534edd43ed337fbad1aaa9029dc5aeea))
- **auth:** strengthen change-password validation to match RegisterDto ([1d623f9](https://github.com/garamahq/bedrock-forge/commit/1d623f918d2aac5ca444b5803eaf33b5eacec90e))
- change folder name ([7d6f6e3](https://github.com/garamahq/bedrock-forge/commit/7d6f6e3375f1f2ce1665ce2dec12d2c0168383e6))
- change release number ([756d07a](https://github.com/garamahq/bedrock-forge/commit/756d07ab4793ce7c3fa96c6086ecc52359d0658e))
- CI action versions, script names in docs, reset.sh secrets, port consistency, release manifest version ([81ff8bd](https://github.com/garamahq/bedrock-forge/commit/81ff8bd8c013cea7793ce1a4db4f483d6a5b7ad7))
- **ci:** add prisma generate step before building api and worker ([585dcbf](https://github.com/garamahq/bedrock-forge/commit/585dcbfa2eaec09242686088ac3d4c6b147b2783))
- **ci:** run prisma migrate from workspace root via pnpm db:deploy ([0cb3056](https://github.com/garamahq/bedrock-forge/commit/0cb305645dd5f58f96f9808a4750563c520a33f2))
- **db:** add tags/roles migrations and seeding ([edad12e](https://github.com/garamahq/bedrock-forge/commit/edad12e93f34adc96a30b3465e70035c0527d79f))
- **db:** normalize enum persistence and add safety migrations ([46e716d](https://github.com/garamahq/bedrock-forge/commit/46e716df61880e796a56e33a179865350d62cd9c))
- **domains:** deduplicate domain records with findOrCreate ([3a491af](https://github.com/garamahq/bedrock-forge/commit/3a491aff2c72e8f030730bb66cfc8b5254348651))
- **entrypoint:** wait for postgres TCP before running migrations ([3e89121](https://github.com/garamahq/bedrock-forge/commit/3e89121d0beed8ec0d37242c60aeab8ec4aeeafb))
- **notifications:** improve Slack channel_not_found error message ([abdfa09](https://github.com/garamahq/bedrock-forge/commit/abdfa09cacf9b4d260e3bad7f07b8f9d179132e5))
- pre-create /tmp/forge-backups as node:node in Dockerfile ([e869640](https://github.com/garamahq/bedrock-forge/commit/e8696402de326f23d5b8e2a85e406e21387340f8))
- **prisma:** add job_type column to JobExecution ([7a9c940](https://github.com/garamahq/bedrock-forge/commit/7a9c940d5906f6c4ea32ce20c4cdc700486d2095))
- **remote-executor:** normalise CRLF line endings in credential parsers ([9cdd239](https://github.com/garamahq/bedrock-forge/commit/9cdd2398ae1533cb7b1a67b60e31be27360ae18b))
- replace 512MB tmpfs with named volume for forge-backups ([aa51bfb](https://github.com/garamahq/bedrock-forge/commit/aa51bfb49ce32d85babf44678bce6211886acd93))
- reset version to 0.1.0, remove stale release history ([e2c8757](https://github.com/garamahq/bedrock-forge/commit/e2c8757a71f5eb7482351cb22945f8365c319b8d))
- **scripts:** make all local scripts robust to parent dir execution by resolving PROJECT_ROOT ([1d5306b](https://github.com/garamahq/bedrock-forge/commit/1d5306b08178f374bdcd6ab0b5e60a62ae206be4))
- **scripts:** robust path handling for site args, Docker Compose db service structure, and related improvements ([750de76](https://github.com/garamahq/bedrock-forge/commit/750de76be63f18ec255b00ab68137fb57db4c77a))
- **scripts:** use PROJECT_ROOT for all project-relative paths in all scripts ([db3fbaa](https://github.com/garamahq/bedrock-forge/commit/db3fbaa1c3b7faba532b3d25d102920419835844))
- **security:** remove CORS wildcard defaults, harden health endpoint and headers ([5c6ec7d](https://github.com/garamahq/bedrock-forge/commit/5c6ec7d0e04497f0a3114591c70955e9fd4eda99))
- simplify Release Please configuration to resolve versionString.match error ([82e987d](https://github.com/garamahq/bedrock-forge/commit/82e987d0eedec57fb1cc1e24a15c9a035ceb3412))
- **site-init:** make new project self-contained and add usage README ([c4ff7fa](https://github.com/garamahq/bedrock-forge/commit/c4ff7fa79c25422f3e82280a50bcc19c323f2817))
- **tests:** update domainsService mocks from create to findOrCreate ([bffc4fa](https://github.com/garamahq/bedrock-forge/commit/bffc4fa4fbbb5ff6d54f68981f4935361e897785))
- update deploy env ([d7131c4](https://github.com/garamahq/bedrock-forge/commit/d7131c45c4bf16b29c4ef3185cac06b151f9b48b))
- update local site creation ([bb69138](https://github.com/garamahq/bedrock-forge/commit/bb69138f70953c46e0776e9252ebf37f3b5306f2))
- updates from grok ([5080204](https://github.com/garamahq/bedrock-forge/commit/5080204fd41383d0f77037d846d4b1797321844e))
- **web:** align UsersPage and AuditLogsPage with API response shapes ([c58038d](https://github.com/garamahq/bedrock-forge/commit/c58038dd9395015ff29cd7b48c8daf57361e10b1))
- **web:** fix destructive badge contrast in dark mode ([277b98b](https://github.com/garamahq/bedrock-forge/commit/277b98bac8c3aba802e18cc46c71764b97cf8dca))
- **web:** remove spurious .then(r =&gt; r.data) on api.post in testConnection ([f979c20](https://github.com/garamahq/bedrock-forge/commit/f979c20f210e12884b0e3c038211e59ecc6cf7f5))
- **web:** token refresh mutex, websocket hardening, ErrorBoundary ([a106013](https://github.com/garamahq/bedrock-forge/commit/a1060135515649ae43425f2a9fcaa1d0d4133c4e))
- **web:** use neutral text-foreground on badge variants; add info variant; add Bedrock Jobs dialog ([3b87b62](https://github.com/garamahq/bedrock-forge/commit/3b87b621b0671244ee8a082c77f09fa80f8fcb0e))
- **worker/backup:** wipe docroot before restore; self-clean orphaned repeatable jobs ([761031c](https://github.com/garamahq/bedrock-forge/commit/761031ce202eb94e703bfee332e9772b72c3ee92))
- **worker/step-tracker:** include stderr and exit code in error log lines ([0044975](https://github.com/garamahq/bedrock-forge/commit/00449759d97323b0400bdbe207a8e32961a366d8))
- **worker:** improve CyberPanel error handling and rollback local DB on failure ([26c3a43](https://github.com/garamahq/bedrock-forge/commit/26c3a43f97e7ec32fa4c4cda3dee60667fa4e763))
- **worker:** pass explicit authTagLength to AES-256-GCM decipher ([e71faf6](https://github.com/garamahq/bedrock-forge/commit/e71faf6379b2f0ca0c0158958e73b49ec76f559b))

### Performance Improvements

- **worker:** cap BullMQ concurrency on all processors for CX23 ([e292963](https://github.com/garamahq/bedrock-forge/commit/e292963221cfed54e2565136d284dd8dc101887a))

## [0.1.0] - 2026-04-16

### Added

- **Server Management** — SSH key vault with AES-256-GCM encryption, CyberPanel
  auto-login, server scanning to bulk-import WordPress environments
- **Project & Client Management** — Clients, projects, tags, hosting packages,
  and support packages with full CRUD
- **Environment Management** — Production / staging per project, DB credential
  vault, environment scanning
- **Backup & Restore** — Full / DB-only / files-only backups via BullMQ queue,
  Google Drive upload via rclone, scheduled backups, restore from any backup
- **Plugin Scanning** — On-demand WordPress plugin scan, enable/disable/delete
  actions
- **Environment Sync** — Cross-server file + database sync via rsync / mysqldump
- **Uptime Monitoring** — Configurable interval, response time tracking, uptime
  percentage, alert logs
- **Domain WHOIS** — Expiry tracking, cached WHOIS data
- **Bedrock Provisioning** — Create fresh Bedrock WordPress + CyberPanel site
  via background job
- **Invoices & Billing** — Yearly invoice generation per project, status
  tracking
- **Slack Notifications** — Per-event channel subscriptions, delivery logs
- **Activity & Audit Logs** — BullMQ job trail + user action audit log
- **Dashboard** — Stats summary, recent job feed via WebSocket
- **Auth & RBAC** — JWT with refresh token rotation, 3-tier role system
  (admin/manager/client)
- **Reports** — Weekly summary report generation
- **Real-time Updates** — WebSocket gateway for live job progress streaming
- **Docker Deployment** — Single-command install via `install.sh`, Docker
  Compose with PostgreSQL + Redis

[0.1.0]: https://github.com/garamahq/bedrock-forge/releases/tag/v0.1.0
