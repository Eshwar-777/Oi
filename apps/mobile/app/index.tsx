import { Redirect } from "expo-router";
import { isMobileAuthBypassEnabled } from "@/lib/devFlags";

export default function IndexRoute() {
  if (isMobileAuthBypassEnabled()) {
    return <Redirect href="/(tabs)/navigator" />;
  }
  return <Redirect href="/(auth)/login" />;
}

