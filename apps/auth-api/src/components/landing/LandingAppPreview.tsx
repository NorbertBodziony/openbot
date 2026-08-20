export function LandingAppPreview() {
  return (
    <section class="landing-preview landing-app-preview" aria-labelledby="app-preview-title" data-enter="preview">
      <h2 id="app-preview-title" class="landing-visually-hidden">
        Interactive OpenBot application preview
      </h2>
      <iframe
        src="/app-preview"
        title="Interactive OpenBot application preview"
        loading="lazy"
        sandbox="allow-forms allow-same-origin allow-scripts"
      />
    </section>
  );
}
