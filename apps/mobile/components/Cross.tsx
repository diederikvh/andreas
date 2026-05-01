import { View } from 'react-native';

type CrossProps = {
  /** Outer diagonal length in px. */
  size: number;
  /** Bar thickness in px. */
  thickness: number;
  /** Bar color. */
  color: string;
};

/**
 * The Andreas brand cross — two thick bars rotated ±45°, no rounded caps.
 * Mirrors `.big-cross::before/after` and `.wl-cross::before/after` from the
 * mockups. Pure-View implementation so no SVG dep is needed.
 */
export function Cross({ size, thickness, color }: CrossProps) {
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: size,
          height: thickness,
          marginTop: -thickness / 2,
          marginLeft: -size / 2,
          backgroundColor: color,
          transform: [{ rotate: '45deg' }],
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: size,
          height: thickness,
          marginTop: -thickness / 2,
          marginLeft: -size / 2,
          backgroundColor: color,
          transform: [{ rotate: '-45deg' }],
        }}
      />
    </View>
  );
}
