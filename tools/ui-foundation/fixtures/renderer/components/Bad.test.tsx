// A .test.tsx neighbour. Skipped by the file loop and excluded from the composite count,
// so neither the Kobalte import nor the dialog role below may reach the report, and the
// data-testid must not reach the hook budget either - counting it there reads 7.
import { Popover } from "@kobalte/core/popover";

export const broken = () => <button role="dialog" data-testid="hook-in-a-test" style={{ color: "#ff0000" }} />;
