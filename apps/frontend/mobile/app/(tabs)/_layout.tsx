import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Redirect, Stack, usePathname, useRouter } from "expo-router";
import { mobileTheme } from "@oi/design-system-mobile";
import {
  CONVERSATION_FILTER_LABELS,
  conversationLabel,
  conversationMatchesFilter,
  conversationStatusTone,
  type ConversationRecentsFilter,
} from "@oi/ui-presentation";
import { useMobileAuth } from "@/features/auth/AuthContext";
import { useMobileAssistant } from "@/features/assistant/MobileAssistantContext";

function MenuIcon() {
  return (
    <View style={styles.menuIcon}>
      <View style={styles.menuIconBar} />
      <View style={styles.menuIconBar} />
      <View style={styles.menuIconBar} />
    </View>
  );
}

function FilterIcon() {
  return (
    <View style={styles.filterIcon}>
      <View style={[styles.filterLine, { width: 16 }]} />
      <View style={[styles.filterLine, { width: 11 }]} />
      <View style={[styles.filterLine, { width: 7 }]} />
    </View>
  );
}

const STATUS_TONE_COLOR: Record<string, string> = {
  danger: mobileTheme.colors.error,
  warning: mobileTheme.colors.warning,
  success: mobileTheme.colors.success,
  brand: mobileTheme.colors.primaryStrong,
  neutral: mobileTheme.colors.textSoft,
};

function DrawerNavItem({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.navItem, active ? styles.navItemActive : null, pressed ? styles.pressed : null]}>
      <Text style={[styles.navLabel, active ? styles.navLabelActive : null]}>{label}</Text>
    </Pressable>
  );
}

export default function TabsLayout() {
  const { status } = useMobileAuth();
  const pathname = usePathname();
  const router = useRouter();
  const {
    conversations,
    createConversation,
    notificationContext,
    selectConversation,
    selectedConversationId,
  } = useMobileAssistant();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<ConversationRecentsFilter>("all");
  const handledNotificationRouteRef = useRef<string | null>(null);

  const filteredConversations = useMemo(
    () => conversations.filter((conversation) => conversationMatchesFilter(conversation, filter)),
    [conversations, filter],
  );

  if (status === "loading") {
    return null;
  }
  if (status !== "authenticated") {
    return <Redirect href="/(auth)/login" />;
  }

  useEffect(() => {
    const route = notificationContext?.route ?? null;
    if (!route || handledNotificationRouteRef.current === route) return;
    handledNotificationRouteRef.current = route;
    router.replace(route as Parameters<typeof router.replace>[0]);
  }, [notificationContext?.route, router]);

  function openRoute(route: "/(tabs)/chat" | "/(tabs)/navigator" | "/(tabs)/schedules" | "/(tabs)/settings") {
    setDrawerOpen(false);
    router.replace(route);
  }

  async function openConversation(conversationId: string) {
    setDrawerOpen(false);
    router.replace("/(tabs)/chat");
    await selectConversation(conversationId);
  }

  return (
    <>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: mobileTheme.colors.surface },
          headerTintColor: mobileTheme.colors.text,
          headerTitleStyle: { fontWeight: "600" },
          headerLeft: () => (
            <Pressable onPress={() => setDrawerOpen(true)} style={({ pressed }) => [styles.headerButton, pressed ? styles.pressed : null]}>
              <MenuIcon />
            </Pressable>
          ),
        }}
      >
        <Stack.Screen name="chat" options={{ title: "Chat" }} />
        <Stack.Screen name="navigator" options={{ title: "Live sessions" }} />
        <Stack.Screen name="schedules" options={{ title: "Schedules" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>

      <Modal visible={drawerOpen} transparent animationType="fade" onRequestClose={() => setDrawerOpen(false)}>
        <View style={styles.overlay}>
          <Pressable style={styles.backdrop} onPress={() => setDrawerOpen(false)} />
          <View style={styles.drawer}>
            <View style={styles.drawerHeader}>
              <Text style={styles.brand}>Oye</Text>
            </View>

            <View style={styles.navSection}>
              <DrawerNavItem active={pathname.includes("/chat")} label="Chat" onPress={() => openRoute("/(tabs)/chat")} />
              <DrawerNavItem active={pathname.includes("/navigator")} label="Sessions" onPress={() => openRoute("/(tabs)/navigator")} />
              <DrawerNavItem active={pathname.includes("/schedules")} label="Schedules" onPress={() => openRoute("/(tabs)/schedules")} />
              <DrawerNavItem active={pathname.includes("/settings")} label="Settings" onPress={() => openRoute("/(tabs)/settings")} />
            </View>

            <View style={styles.divider} />

            <View style={styles.recentsHeader}>
              <Text style={styles.recentsTitle}>Recents</Text>
              <Pressable onPress={() => setFilterOpen((value) => !value)} style={({ pressed }) => [styles.filterButton, pressed ? styles.pressed : null]}>
                <FilterIcon />
              </Pressable>
            </View>

            {filterOpen ? (
              <View style={styles.filterMenu}>
                {(Object.keys(CONVERSATION_FILTER_LABELS) as ConversationRecentsFilter[]).map((key) => (
                  <Pressable
                    key={key}
                    onPress={() => {
                      setFilter(key);
                      setFilterOpen(false);
                    }}
                    style={({ pressed }) => [styles.filterItem, key === filter ? styles.filterItemActive : null, pressed ? styles.pressed : null]}
                  >
                    <Text style={[styles.filterItemText, key === filter ? styles.filterItemTextActive : null]}>
                      {CONVERSATION_FILTER_LABELS[key]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <ScrollView style={styles.recentsList} contentContainerStyle={styles.recentsListContent}>
              {filteredConversations.map((conversation) => {
                const selected = conversation.conversation_id === selectedConversationId;
                return (
                  <Pressable
                    key={conversation.conversation_id}
                    onPress={() => void openConversation(conversation.conversation_id)}
                    style={({ pressed }) => [styles.recentRow, selected ? styles.recentRowActive : null, pressed ? styles.pressed : null]}
                  >
                    <View style={[styles.statusDot, { backgroundColor: STATUS_TONE_COLOR[conversationStatusTone(conversation)] }]} />
                    <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.recentLabel, selected ? styles.recentLabelActive : null]}>
                      {conversationLabel(conversation.title)}
                    </Text>
                  </Pressable>
                );
              })}

              {filteredConversations.length === 0 ? (
                <Text style={styles.emptyRecents}>No matching conversations</Text>
              ) : null}
            </ScrollView>

            <Pressable
              onPress={() => {
                setDrawerOpen(false);
                router.replace("/(tabs)/chat");
                void createConversation();
              }}
              style={({ pressed }) => [styles.newChatButton, pressed ? styles.pressed : null]}
            >
              <Text style={styles.newChatLabel}>New chat</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "rgba(20, 20, 19, 0.28)",
  },
  backdrop: {
    flex: 1,
  },
  drawer: {
    width: 304,
    maxWidth: "82%",
    backgroundColor: mobileTheme.colors.surface,
    borderRightWidth: 1,
    borderRightColor: mobileTheme.colors.border,
    paddingTop: mobileTheme.spacing[8],
    paddingHorizontal: mobileTheme.spacing[4],
    paddingBottom: mobileTheme.spacing[5],
  },
  drawerHeader: {
    marginBottom: mobileTheme.spacing[4],
  },
  brand: {
    fontSize: mobileTheme.typography.fontSize.xl,
    fontWeight: "800",
    color: mobileTheme.colors.text,
  },
  navSection: {
    gap: mobileTheme.spacing[2],
  },
  navItem: {
    borderRadius: mobileTheme.radii.md,
    paddingHorizontal: mobileTheme.spacing[3],
    paddingVertical: mobileTheme.spacing[3],
  },
  navItemActive: {
    backgroundColor: mobileTheme.colors.surfaceMuted,
  },
  navLabel: {
    fontSize: mobileTheme.typography.fontSize.base,
    fontWeight: "600",
    color: mobileTheme.colors.textMuted,
  },
  navLabelActive: {
    color: mobileTheme.colors.text,
  },
  divider: {
    height: 1,
    backgroundColor: mobileTheme.colors.border,
    marginVertical: mobileTheme.spacing[4],
  },
  recentsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: mobileTheme.spacing[2],
  },
  recentsTitle: {
    fontSize: mobileTheme.typography.fontSize.sm,
    fontWeight: "700",
    color: mobileTheme.colors.textMuted,
    letterSpacing: 0.4,
  },
  filterButton: {
    padding: mobileTheme.spacing[2],
    borderRadius: 999,
  },
  filterMenu: {
    marginBottom: mobileTheme.spacing[2],
    borderRadius: mobileTheme.radii.md,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    overflow: "hidden",
  },
  filterItem: {
    paddingHorizontal: mobileTheme.spacing[3],
    paddingVertical: mobileTheme.spacing[2],
    backgroundColor: mobileTheme.colors.surface,
  },
  filterItemActive: {
    backgroundColor: mobileTheme.colors.surfaceMuted,
  },
  filterItemText: {
    color: mobileTheme.colors.textMuted,
    fontSize: mobileTheme.typography.fontSize.sm,
  },
  filterItemTextActive: {
    color: mobileTheme.colors.text,
    fontWeight: "600",
  },
  recentsList: {
    flex: 1,
  },
  recentsListContent: {
    gap: mobileTheme.spacing[1],
    paddingBottom: mobileTheme.spacing[4],
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: mobileTheme.spacing[2],
    borderRadius: mobileTheme.radii.md,
    paddingHorizontal: mobileTheme.spacing[2],
    paddingVertical: mobileTheme.spacing[2],
  },
  recentRowActive: {
    backgroundColor: mobileTheme.colors.surfaceMuted,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  recentLabel: {
    flex: 1,
    fontSize: mobileTheme.typography.fontSize.base,
    color: mobileTheme.colors.text,
  },
  recentLabelActive: {
    fontWeight: "700",
  },
  emptyRecents: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textMuted,
    paddingVertical: mobileTheme.spacing[2],
  },
  newChatButton: {
    marginTop: mobileTheme.spacing[3],
    borderRadius: mobileTheme.radii.md,
    paddingHorizontal: mobileTheme.spacing[3],
    paddingVertical: mobileTheme.spacing[3],
    backgroundColor: mobileTheme.colors.surfaceMuted,
  },
  newChatLabel: {
    fontSize: mobileTheme.typography.fontSize.base,
    fontWeight: "700",
    color: mobileTheme.colors.text,
  },
  headerButton: {
    marginLeft: mobileTheme.spacing[1],
    padding: mobileTheme.spacing[2],
    borderRadius: 999,
  },
  pressed: {
    opacity: 0.72,
  },
  menuIcon: {
    width: 18,
    gap: 3,
  },
  menuIconBar: {
    height: 2,
    borderRadius: 999,
    backgroundColor: mobileTheme.colors.text,
  },
  filterIcon: {
    alignItems: "flex-end",
    gap: 2,
    width: 16,
  },
  filterLine: {
    height: 2,
    borderRadius: 999,
    backgroundColor: mobileTheme.colors.text,
  },
});
