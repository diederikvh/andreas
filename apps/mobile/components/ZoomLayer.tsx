/**
 * Top-level overlay zodat een pinch-zoom image visueel boven álles
 * uitkomt — niet alleen boven z'n eigen card. Lost het probleem op
 * dat zIndex binnen een FlatList nooit boven naburige cards uit kan.
 *
 * Pattern: één globale SharedValue voor de scale, plus React-state
 * voor de URL + measure-position. PinchableImage zet de state aan/uit
 * en muteert de scale; ZoomLayer rendert de zwevende image-copy op
 * dezelfde scherm-positie als 't origineel met dezelfde scale.
 */
import { Image } from 'expo-image';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

type ZoomState = {
  uri: string;
  x: number;
  y: number;
  width: number;
  height: number;
} | null;

type Ctx = {
  scale: SharedValue<number>;
  start: (s: NonNullable<ZoomState>) => void;
  end: () => void;
};

const ZoomCtx = createContext<Ctx | null>(null);

export function ZoomLayerProvider({ children }: { children: ReactNode }) {
  const scale = useSharedValue(1);
  const [state, setState] = useState<ZoomState>(null);

  const start: Ctx['start'] = (s) => {
    scale.value = 1;
    setState(s);
  };
  const end: Ctx['end'] = () => {
    setState(null);
  };

  return (
    <ZoomCtx.Provider value={{ scale, start, end }}>
      {children}
      <ZoomLayer state={state} scale={scale} />
    </ZoomCtx.Provider>
  );
}

export function useZoomLayer(): Ctx {
  const ctx = useContext(ZoomCtx);
  if (!ctx) {
    throw new Error('useZoomLayer must be used inside <ZoomLayerProvider>');
  }
  return ctx;
}

function ZoomLayer({
  state,
  scale,
}: {
  state: ZoomState;
  scale: SharedValue<number>;
}) {
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  if (!state) return null;
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    >
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: state.x,
            top: state.y,
            width: state.width,
            height: state.height,
            overflow: 'hidden',
          },
          animStyle,
        ]}
      >
        <Image
          source={{ uri: state.uri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
        />
      </Animated.View>
    </View>
  );
}
