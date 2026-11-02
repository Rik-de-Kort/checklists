// Every release of the app, oldest first. When the app's files change, tests/version.test.ts
// fails with their new fingerprint: add an entry with the next version and that hash.
export const HISTORY: { version: number; hash: string }[] = [
  {
    version: 1,
    hash: "52e784cc3b2e7d00c09859db05911b6f71c8ff4160ae7d6f5a4e50150dd0b06c",
  },
  {
    version: 2,
    hash: "376a660b8bcc9926fb4bd63c0950efa9113eb5f386b32edd025d9fc4d8399bc5",
  },
  {
    version: 3,
    hash: "e9b62820cae8b51ec69c93387dcf5c60e67ef7dc489a9a283526d4503ce6cb66",
  },
  {
    version: 4,
    hash: "70467ee7195ed23cb37deca4ee764c80a961fcb27d8accf1305873bab19c096e",
  },
];

const latest = HISTORY.at(-1);
if (!latest) throw new Error("HISTORY in src/version.ts is empty");
export const VERSION = latest.version;
