import { inject } from "vitest";
import { requireTempRoot } from "./temp-root.js";

// os.tmpdir() reads TMPDIR on every call, so each mkdtemp the tests make under it lands in the
// run's root, which the global setup removes when the run ends.
process.env.TMPDIR = requireTempRoot(inject("tempRoot"));
