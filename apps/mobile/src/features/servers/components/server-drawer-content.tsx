import { MenuView } from "@expo/ui/community/menu";
import type { Href } from "expo-router";
import { Typography } from "heroui-native";
import { Monitor, Plus, Server, Settings } from "lucide-react-native";
import { useRef } from "react";
import { Alert, Pressable, ScrollView, View, type ViewStyle } from "react-native";

import type { MobileSession } from "@/features/auth/api/mobile-auth";
import type { MobileServer } from "@/features/workspace/context/mobile-workspace-context";
import { ProfileAvatar } from "@/shared/components/profile-avatar";
import { SheetScrollEdgeEffect } from "@/shared/components/sheet-scroll-edge-effect";

import { ServerDrawerIconButton } from "./server-drawer-icon-button";

interface ServerDrawerContentProps {
  activeServerId: string;
  headerHeight: number;
  listTopInset: number;
  muted: ViewStyle["backgroundColor"];
  servers: MobileServer[];
  session: MobileSession;
  sideInset: number;
  topInset: number;
  onNavigate: (href: Href) => void;
  onSelectServer: (serverId: string) => void;
  onLeaveServer: (serverId: string) => Promise<void>;
}

export function ServerDrawerContent({
  activeServerId,
  headerHeight,
  listTopInset,
  muted,
  servers,
  session,
  sideInset,
  topInset,
  onNavigate,
  onSelectServer,
  onLeaveServer,
}: ServerDrawerContentProps) {
  const leaving = useRef(false);
  function confirmLeave(server: MobileServer): void {
    Alert.alert(`Leave ${server.name}?`, "You will need another invitation to join again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave server",
        style: "destructive",
        onPress: () => {
          if (leaving.current) return;
          leaving.current = true;
          void onLeaveServer(server.id)
            .catch((error) => {
              Alert.alert("Could not leave server", error instanceof Error ? error.message : "Please try again.");
            })
            .finally(() => {
              leaving.current = false;
            });
        },
      },
    ]);
  }
  const emailSeparatorIndex = session.user.email.indexOf("@");
  const displayName = emailSeparatorIndex > 0 ? session.user.email.slice(0, emailSeparatorIndex) : session.user.email;
  const mutedColor = String(muted);

  return (
    <>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-1 pr-3"
        contentContainerStyle={{ paddingTop: listTopInset }}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
      >
        {servers.map((serverItem) => {
          const selected = serverItem.id === activeServerId;
          const ServerIcon = serverItem.kind === "local" ? Monitor : Server;
          const serverLabel = serverItem.kind === "local" ? "Local" : "Remote";

          const row = (
            <Pressable
              key={serverItem.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${serverItem.name}, ${serverLabel}`}
              accessibilityActions={
                serverItem.kind === "remote" ? [{ name: "leave", label: "Leave server" }] : undefined
              }
              onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === "leave" && serverItem.kind === "remote") confirmLeave(serverItem);
              }}
              className="min-h-16 flex-row items-center gap-3 rounded-2xl px-3 py-2"
              onPress={() => onSelectServer(serverItem.id)}
              style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
            >
              {selected ? (
                <View
                  style={{
                    backgroundColor: serverItem.accent,
                    borderRadius: 999,
                    bottom: 16,
                    left: 0,
                    position: "absolute",
                    top: 16,
                    width: 3,
                  }}
                />
              ) : null}
              <View
                className="size-11 items-center justify-center rounded-[15px]"
                style={{ backgroundColor: serverItem.accent, borderCurve: "continuous" }}
              >
                <ServerIcon color="#100d12" size={21} strokeWidth={1.8} />
              </View>
              <View className="min-w-0 flex-1 gap-0.5">
                <Typography.Paragraph weight={selected ? "bold" : "semibold"} numberOfLines={1}>
                  {serverItem.name}
                </Typography.Paragraph>
                <Typography.Paragraph type="body-xs" className="text-text-secondary">
                  {serverLabel}
                </Typography.Paragraph>
              </View>
            </Pressable>
          );
          return serverItem.kind === "remote" ? (
            <MenuView
              key={serverItem.id}
              shouldOpenOnLongPress
              actions={[
                {
                  id: "leave",
                  title: "Leave server",
                  attributes: { destructive: true },
                  image: "rectangle.portrait.and.arrow.right",
                },
              ]}
              onPressAction={(event) => {
                if (event.nativeEvent.event === "leave") confirmLeave(serverItem);
              }}
            >
              {row}
            </MenuView>
          ) : (
            row
          );
        })}
      </ScrollView>

      <SheetScrollEdgeEffect
        style={{ height: headerHeight + 20, left: -sideInset, position: "absolute", right: -34, top: 0, zIndex: 10 }}
      />

      <View
        className="absolute right-0 z-20 h-14 flex-row items-center justify-between pr-3"
        pointerEvents="box-none"
        style={{ left: -sideInset, paddingLeft: sideInset + 12, top: Math.max(topInset, 16) }}
      >
        <Typography.Heading type="h1" weight="bold">
          Servers
        </Typography.Heading>
        <ServerDrawerIconButton
          accessibilityLabel="Join a server"
          color={mutedColor}
          fallbackVariant="filled"
          systemName="plus"
          onPress={() => onNavigate("/add-server")}
        >
          <Plus color={mutedColor} size={18} strokeWidth={2} />
        </ServerDrawerIconButton>
      </View>

      <View className="mr-3 flex-row items-center gap-2 pt-2">
        <View className="min-h-14 min-w-0 flex-1 flex-row items-center gap-2.5 rounded-2xl px-2 py-2">
          <ProfileAvatar name={displayName} imageUrl={session.user.avatarUrl} size={36} />
          <View className="min-w-0 flex-1">
            <Typography.Paragraph type="body-sm" weight="semibold" numberOfLines={1}>
              {displayName}
            </Typography.Paragraph>
            <Typography.Paragraph type="body-xs" className="text-text-secondary" numberOfLines={1} selectable>
              {session.user.email}
            </Typography.Paragraph>
          </View>
        </View>
        <ServerDrawerIconButton
          accessibilityLabel="Settings"
          color={mutedColor}
          systemName="gearshape"
          onPress={() => onNavigate("/settings")}
        >
          <Settings color={mutedColor} size={18} strokeWidth={1.8} />
        </ServerDrawerIconButton>
      </View>
    </>
  );
}
