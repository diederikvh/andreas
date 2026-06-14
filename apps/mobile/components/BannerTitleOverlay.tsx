/**
 * Title-overlay voor banner-images op event-cards. Verticale gradient
 * van transparant → donker zodat de tekst leesbaar is, en de event-
 * titel onderaan in display-font. Gebruikt wanneer 't event geen
 * eigen image heeft en we terugvallen op venue.imageUrl — dan vult
 * de titel het gat dat normaal de event-poster invult.
 *
 * Visueel gespiegeld aan de FeaturedCard op Vandaag.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { useMode } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

export function BannerTitleOverlay({ title }: { title: string }) {
  const mode = useMode();
  const isNacht = mode === 'nacht';
  return (
    <>
      <LinearGradient
        colors={
          isNacht
            ? [
                'rgba(10,10,11,0)',
                'rgba(10,10,11,0)',
                'rgba(10,10,11,0.55)',
                'rgba(10,10,11,0.85)',
              ]
            : [
                'rgba(0,0,0,0)',
                'rgba(0,0,0,0)',
                'rgba(0,0,0,0.45)',
                'rgba(0,0,0,0.72)',
              ]
        }
        locations={[0, 0.35, 0.7, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.titleWrap} pointerEvents="none">
        <Text style={styles.title} numberOfLines={3}>
          {title}
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  titleWrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 28,
    lineHeight: 28 * 0.95,
    letterSpacing: -0.84,
    color: '#fff',
  },
});
