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
  {
    version: 5,
    hash: "f00644cd4836c56c5e49aa3ba227f7d8e44e4377746ff301e42680d081102522",
  },
  {
    version: 6,
    hash: "14e8cc242cc67fbf952433f7738f11e858b6afef824972a8d190e0bf7f0b6397",
  },
  {
    version: 7,
    hash: "812195c44fcad10b7a107a6d39cbd456d545cbcdb50f42244ebb82a3660fcd74",
  },
  {
    version: 8,
    hash: "0c1be4efab280ec916aa0ede09d80b7c590b2ebac47b443d02cd6908e990e6d5",
  },
  {
    version: 9,
    hash: "9ffee45caa76b259218f3a6306f4f4f3a302fe46eb6dbe0bb92b06534aab8f27",
  },
];

const latest = HISTORY.at(-1);
if (!latest) throw new Error("HISTORY in src/version.ts is empty");
export const VERSION = latest.version;
