// The composite count is per occurrence, not per file, so every remaining role in the
// pattern is observable from one file: drop one from the alternation and the count falls
// by exactly one. dialog and menu are covered by Composite.tsx and features/inbox.
export const CompositeRoles = () => (
  <div role="alertdialog">
    <div role="tablist">
      <div role="tab" />
      <div role="tabpanel" />
    </div>
    <div role="listbox">
      <div role="option" />
    </div>
  </div>
);
