import type { Href } from "expo-router";
import { Typography } from "heroui-native";
import { Monitor, Plus, Server, Settings, Wifi, WifiOff } from "lucide-react-native";
import { Pressable, ScrollView, View, type ViewStyle } from "react-native";

import type { MobileSession } from "@/features/auth/api/mobile-auth";
import type { MobileServer } from "@/features/workspace/context/mobile-workspace-context";
import { ProfileAvatar } from "@/shared/components/profile-avatar";
import { SheetScrollEdgeEffect } from "@/shared/components/sheet-scroll-edge-effect";

interface ServerDrawerContentProps {
  activeServerId: string;
  foreground: ViewStyle["backgroundColor"];
  headerHeight: number;
  listTopInset: number;
  muted: ViewStyle["backgroundColor"];
  servers: MobileServer[];
  session: MobileSession;
  sideInset: number;
  topInset: number;
  onNavigate: (href: Href) => void;
  onSelectServer: (serverId: string) => void;
}

export function ServerDrawerContent({
  activeServerId,
  foreground,
  headerHeight,
  listTopInset,
  muted,
  servers,
  session,
  sideInset,
  topInset,
  onNavigate,
  onSelectServer,
}: ServerDrawerContentProps) {
  const emailSeparatorIndex = session.user.email.indexOf("@");
  const displayName = emailSeparatorIndex > 0 ? session.user.email.slice(0, emailSeparatorIndex) : session.user.email;
  const iconColor = String(foreground);
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
          const StateIcon = serverItem.state === "online" ? Wifi : WifiOff;

          return (
            <Pressable
              key={serverItem.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`${serverItem.name}, ${serverItem.state}`}
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
                <View className="flex-row items-center gap-1.5">
                  <StateIcon color={mutedColor} size={12} strokeWidth={2} />
                  <Typography.Paragraph type="body-xs" className="capitalize text-text-secondary">
                    {serverItem.state}
                    {serverItem.kind === "remote" ? " · Remote" : " · Paired desktop"}
                  </Typography.Paragraph>
                </View>
              </View>
            </Pressable>
          );
        })}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Join a server"
          className="mt-2 min-h-14 flex-row items-center gap-3 rounded-2xl px-3 py-2"
          onPress={() => onNavigate("/add-server")}
          style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
        >
          <View className="size-11 items-center justify-center rounded-[15px] border border-border bg-control">
            <Plus color={iconColor} size={21} strokeWidth={1.8} />
          </View>
          <Typography.Paragraph weight="semibold">Join a server</Typography.Paragraph>
        </Pressable>
      </ScrollView>

      <SheetScrollEdgeEffect
        style={{ height: headerHeight + 20, left: -sideInset, position: "absolute", right: -34, top: 0, zIndex: 10 }}
      />

      <View
        className="absolute right-0 z-20 h-14 justify-center"
        pointerEvents="none"
        style={{ left: -sideInset, paddingLeft: sideInset + 12, top: Math.max(topInset, 16) }}
      >
        <Typography.Heading type="h1" weight="bold">
          Servers
        </Typography.Heading>
      </View>

      <View className="mr-3 flex-row items-center gap-2  pt-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Account: ${displayName}`}
          className="min-h-14 min-w-0 flex-1 flex-row items-center gap-2.5 rounded-2xl px-2 py-2"
          onPress={() => onNavigate("/settings")}
          style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
        >
          <ProfileAvatar name={displayName} imageUrl={session.user.avatarUrl} size={36} />
          <View className="min-w-0 flex-1">
            <Typography.Paragraph type="body-sm" weight="semibold" numberOfLines={1}>
              {displayName}
            </Typography.Paragraph>
            <Typography.Paragraph type="body-xs" className="text-text-secondary" numberOfLines={1} selectable>
              {session.user.email}
            </Typography.Paragraph>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          hitSlop={8}
          className="size-10 items-center justify-center rounded-full"
          onPress={() => onNavigate("/settings")}
          style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
        >
          <Settings color={mutedColor} size={18} strokeWidth={1.8} />
        </Pressable>
      </View>
    </>
  );
}
