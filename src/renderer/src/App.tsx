import { AppAccessGate } from "./AppView";
import { type AppProps, AppProviders } from "./app-providers";
import { Toaster } from "./components/ui";

export function App(props: AppProps = {}) {
  return (
    <>
      <AppProviders landingPreview={props.landingPreview} peopleEnabled={props.peopleEnabled}>
        <AppAccessGate />
      </AppProviders>
      <Toaster />
    </>
  );
}
