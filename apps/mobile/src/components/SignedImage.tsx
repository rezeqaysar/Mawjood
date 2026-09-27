import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import { useTheme } from '../lib/theme';
import { engine } from '../lib/engine';

/**
 * Photo from the private item-photos bucket (P0-6): resolves a signed URL
 * on mount (cached in the engine) and renders it. While loading shows a
 * subtle spinner box of the same size so layouts don't jump.
 */
export function SignedImage({
  photo,
  style,
  resizeMode,
}: {
  photo: string | null | undefined;
  style?: any;
  resizeMode?: 'cover' | 'contain' | 'stretch' | 'center';
}) {
  const { palette: P } = useTheme();
  const [uri, setUri] = useState<string | null>(null);
  const [lastPhoto, setLastPhoto] = useState(photo);
  // reset on photo change during render (React-endorsed pattern — the effect
  // below only ever _fills_ the uri, never clears it)
  if (photo !== lastPhoto) {
    setLastPhoto(photo);
    setUri(null);
  }
  useEffect(() => {
    let live = true;
    if (!photo) return;
    engine
      .signedPhotoUrl(photo)
      .then((u) => { if (live) setUri(u); })
      .catch((e) => { console.warn('signedPhotoUrl failed', e); });
    return () => { live = false; };
  }, [photo]);
  if (!uri) {
    return (
      <View style={[style, { alignItems: 'center', justifyContent: 'center', backgroundColor: P.bubbleApp }]}>
        <ActivityIndicator size="small" color={P.faint2} />
      </View>
    );
  }
  return <Image source={{ uri }} style={style} resizeMode={resizeMode} />;
}
