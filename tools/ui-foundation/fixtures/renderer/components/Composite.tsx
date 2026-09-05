// The one composite ARIA role the tree is allowed to contain, so the ratchet counts 1.
// If either exclusion below it breaks, the count goes up and the test says by how much.
export function Composite() {
  return <div role="dialog" />;
}
