import { RouterProvider } from "react-router-dom";
import { AppProviders } from "./app/AppProviders";
import { router } from "./routes/router";

const RoutedApp = RouterProvider as unknown as (props: {
  router: typeof router;
}) => JSX.Element;

export function App() {
  return (
    <AppProviders>
      <RoutedApp router={router} />
    </AppProviders>
  );
}
