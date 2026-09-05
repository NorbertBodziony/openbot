// The neighbour every per-file check must leave alone. A capitalised component is not a
// native control, and a token is not a literal - both distinctions are the whole point.
import { Button } from "./ui/Button";

export function Good() {
  return <Button style={{ color: "var(--openbot-text)", "border-radius": "var(--openbot-radius-md)" }} />;
}
