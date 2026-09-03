import type { PropsWithChildren, ReactNode } from "react";
import { ScrollView, type ScrollViewProps, View } from "react-native";

import { SheetScrollEdgeEffect } from "@/shared/components/sheet-scroll-edge-effect";

interface SheetScrollViewProps extends PropsWithChildren {
  className?: string;
  contentContainerClassName?: string;
  contentInsetAdjustmentBehavior?: ScrollViewProps["contentInsetAdjustmentBehavior"];
  header?: ReactNode;
  keyboardDismissMode?: ScrollViewProps["keyboardDismissMode"];
  keyboardShouldPersistTaps?: ScrollViewProps["keyboardShouldPersistTaps"];
  showsVerticalScrollIndicator?: boolean;
}

export function SheetScrollView({
  children,
  className = "bg-background",
  contentContainerClassName,
  contentInsetAdjustmentBehavior = "automatic",
  header,
  keyboardDismissMode,
  keyboardShouldPersistTaps,
  showsVerticalScrollIndicator = false,
}: SheetScrollViewProps) {
  return (
    <ScrollView
      className={className}
      contentInsetAdjustmentBehavior={contentInsetAdjustmentBehavior}
      keyboardDismissMode={keyboardDismissMode}
      keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      stickyHeaderIndices={[0]}
    >
      <View className="z-10" style={header ? undefined : { height: 1, marginBottom: -1 }}>
        <SheetScrollEdgeEffect
          style={
            header
              ? { bottom: -24, left: 0, position: "absolute", right: 0, top: 0 }
              : { height: 34, left: 0, position: "absolute", right: 0, top: 0 }
          }
        />
        {header}
      </View>
      <View className={contentContainerClassName}>{children}</View>
    </ScrollView>
  );
}
