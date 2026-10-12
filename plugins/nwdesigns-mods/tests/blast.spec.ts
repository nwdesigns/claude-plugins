import { describe, test, expect } from "bun:test";
import { classify, gitCommits, isRemotePath } from "../lib/blast.ts";

// The Blast Radius classifier: which Bash commands are held.

const kind = (c: string) => classify(c)?.kind ?? null;
const RM = ["rm", "-rf"].join(" ");

describe("blast-radius upstream holds", () => {
  test("rm, git and migrations", () => {
    expect(kind(`${RM} ./tmpdir`)).toBe("rm");
    expect(kind("sudo rm -r build")).toBe("rm");
    expect(kind("git reset --hard HEAD~1")).toBe("git-reset");
    expect(kind("git clean -fdx")).toBe("git-clean");
    expect(kind("git push --force origin main")).toBe("git-push-force");
    expect(kind("git checkout -- .")).toBe("git-checkout");
    expect(kind("python3 manage.py migrate")).toBe("migrate");
  });

  test("plain commands pass", () => {
    for (const c of [
      "rm a.txt",
      "git status",
      "git push origin main",
      "ls -la",
      "git restore --staged .",
    ])
      expect(kind(c)).toBeNull();
  });

  test("a cd earlier on the line moves the folder; a subshell scopes it", () => {
    expect(classify(`cd sub && ${RM} build`)?.dir).toBe("sub");
    expect(classify(`(cd sub && make) && ${RM} build`)?.dir).toBeNull();
  });
});

describe("blast-radius WP-CLI holds", () => {
  test("wp db reset, drop and import", () => {
    expect(kind("wp db reset --yes")).toBe("wp-db");
    expect(kind("wp db drop --yes")).toBe("wp-db");
    expect(kind("wp db import dump.sql")).toBe("wp-db");
    expect(kind("wp @prod db import dump.sql")).toBe("wp-db");
    expect(kind("wp db export backup.sql")).toBeNull();
    expect(kind("wp db query 'SELECT 1'")).toBeNull();
  });

  test("search-replace: held on a non-local target, all tables, network or a remote site", () => {
    for (const c of [
      "wp search-replace http://site.test https://example.com",
      "wp search-replace old new --all-tables",
      "wp search-replace old new --network",
      "wp @prod search-replace https://a.com https://b.com",
      "wp --ssh=user@host search-replace a b",
    ])
      expect(kind(c)).toBe("wp-search-replace");
  });

  test("search-replace: a dry run, a local target or plain text passes", () => {
    for (const c of [
      "wp search-replace https://example.com http://site.test",
      "wp search-replace https://example.com http://localhost:8080",
      "wp search-replace https://example.com https://site.ddev.site",
      "wp search-replace https://example.com http://site.local --precise",
      "wp search-replace http://site.test https://example.com --dry-run",
      "wp search-replace --all-tables old new --dry-run",
      "wp search-replace 'Old Name' 'New Name'",
    ])
      expect(kind(c)).toBeNull();
  });
});

describe("blast-radius rsync holds", () => {
  test("rsync --delete and its variants", () => {
    expect(kind("rsync -av --delete src/ dst/")).toBe("rsync-delete");
    expect(kind("rsync -av --delete-after src/ user@host:/var/www/")).toBe(
      "rsync-delete",
    );
    expect(kind("rsync -av src/ dst/")).toBeNull();
  });

  test("remote rsync paths", () => {
    expect(isRemotePath("user@host:/var/www/")).toBe(true);
    expect(isRemotePath("rsync://host/mod")).toBe(true);
    expect(isRemotePath("./dist/")).toBe(false);
    expect(isRemotePath("/srv/a:b")).toBe(false);
  });
});

describe("gitCommits", () => {
  test("each commit with the folder it runs in and its -a", () => {
    expect(gitCommits("cd app && git commit -am x; git -C ../lib commit -m y")).toEqual([
      { dir: "app", all: true },
      { dir: "app/../lib", all: false },
    ]);
    expect(gitCommits("(cd sub && make) && git commit --all")).toEqual([
      { dir: null, all: true },
    ]);
    expect(gitCommits("git status && echo commit")).toEqual([]);
  });
});
