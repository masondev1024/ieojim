import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Group } from 'three';
import { SRGBColorSpace } from 'three';

function PeopleMarkers({ progress }: { progress: number }) {
  const markers = useMemo(() => [-1.35, -0.45, 0.45, 1.35], []);
  return (
    <group position={[-2.45, 0.85, 0]}>
      {markers.map((x, index) => {
        const leaving = index === markers.length - 1;
        const opacity = leaving ? 1 - progress * 0.82 : 1;
        const y = leaving ? progress * 0.42 : 0;
        return (
          <mesh key={x} position={[x, y, leaving ? progress * -0.35 : 0]} scale={leaving ? 1 - progress * 0.18 : 1}>
            <sphereGeometry args={[0.17, 24, 16]} />
            <meshStandardMaterial color={leaving ? '#d59d58' : '#f6efe0'} transparent opacity={opacity} roughness={0.72} />
          </mesh>
        );
      })}
    </group>
  );
}

function CardMesh({ children, position, accent = '#f7f0df' }: { children?: ReactNode; position: [number, number, number]; accent?: string }) {
  return (
    <group position={position}>
      <mesh>
        <boxGeometry args={[2.45, 1.12, 0.08]} />
        <meshStandardMaterial color="#f8f0df" roughness={0.82} metalness={0.02} />
      </mesh>
      <mesh position={[0, -0.58, 0.055]}>
        <boxGeometry args={[2.12, 0.045, 0.035]} />
        <meshStandardMaterial color={accent} roughness={0.65} />
      </mesh>
      {children}
    </group>
  );
}

function Connector({ progress }: { progress: number }) {
  const scale = Math.max(0.001, 0.28 + progress * 0.72);
  return (
    <mesh position={[0, 0.87, 0]} scale={[scale, 1, 1]}>
      <boxGeometry args={[2.4, 0.035, 0.035]} />
      <meshStandardMaterial color="#9bd7bf" emissive="#1c5f48" emissiveIntensity={0.16} roughness={0.5} />
    </mesh>
  );
}

function ContinuityMesh({ progress, active }: { progress: number; active: boolean }) {
  const groupRef = useRef<Group>(null);
  useFrame(() => {
    if (!active || !groupRef.current) return;
    groupRef.current.rotation.y = Math.sin(performance.now() / 950) * 0.035;
    groupRef.current.position.y = Math.sin(performance.now() / 1100) * 0.025;
  });

  return (
    <group ref={groupRef}>
      <ambientLight intensity={1.4} />
      <directionalLight position={[3.5, 5, 4]} intensity={2.2} />
      <pointLight position={[-3, -2, 3]} color="#9bd7bf" intensity={1.9} />
      <CardMesh position={[-2.55, 0.85, 0]} accent="#d59d58" />
      <PeopleMarkers progress={progress} />
      <Connector progress={progress} />
      <CardMesh position={[2.55, 0.85, 0]} accent="#9bd7bf">
        <mesh position={[0.58, 0.16, 0.09]} scale={[0.22 + progress * 0.18, 0.22 + progress * 0.18, 0.22 + progress * 0.18]}>
          <sphereGeometry args={[0.34, 32, 18]} />
          <meshStandardMaterial color="#9bd7bf" emissive="#245f4b" emissiveIntensity={0.12} roughness={0.44} />
        </mesh>
      </CardMesh>
      <CardMesh position={[2.35, -0.72, -0.12]} accent="#cbd7cf">
        <mesh position={[-0.76, 0.14, 0.09]} rotation={[0, 0, -0.28]}>
          <boxGeometry args={[0.12, 0.56, 0.08]} />
          <meshStandardMaterial color="#315142" roughness={0.6} />
        </mesh>
      </CardMesh>
      <mesh position={[0, -1.63, -0.14]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[7.2, 3.8]} />
        <meshStandardMaterial color="#0f1a17" roughness={1} />
      </mesh>
    </group>
  );
}

function ContextLossHandler({ onError }: { onError: () => void }) {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    const element = gl.domElement;
    element.addEventListener('webglcontextlost', onError);
    return () => element.removeEventListener('webglcontextlost', onError);
  }, [gl, onError]);

  return null;
}

export default function ContinuityCanvas({ progress, active, onError }: { progress: number; active: boolean; onError: () => void }) {
  return (
    <Canvas
      camera={{ position: [0, 1.2, 9.6], fov: 43 }}
      dpr={[1, 1.5]}
      frameloop={active ? 'always' : 'demand'}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = SRGBColorSpace;
      }}
    >
      <ContextLossHandler onError={onError} />
      <ContinuityMesh progress={progress} active={active} />
    </Canvas>
  );
}
