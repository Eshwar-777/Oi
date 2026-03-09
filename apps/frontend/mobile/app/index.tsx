import { Redirect } from "expo-router";
import { useMobileAuth } from "@/features/auth/AuthContext";

export default function IndexRoute() {
  const { status } = useMobileAuth();

  if (status === "loading") {
    return null;
  }
  if (status === "authenticated") {
    return <Redirect href="/(tabs)/navigator" />;
  }
  return <Redirect href="/(auth)/login" />;
}
