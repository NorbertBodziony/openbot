// A .test.tsx neighbour. Skipped by the file loop and excluded from the composite count,
// so neither the Kobalte import nor the dialog role below may reach the report.
import { Popover } from "@kobalte/core/popover";

export const broken = () => <button role="dialog" style={{ color: "#ff0000" }} />;
