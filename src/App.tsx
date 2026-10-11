import { useMemo, useState } from 'react';
import { Landing } from './components/landing/Landing';
import { Dashboard } from './components/app/Dashboard';
import { SettingsModal } from './components/settings/SettingsModal';
import { useSettings } from './state/useSettings';
import { useSearchSession } from './state/useSearchSession';

export default function App() {
  const settings = useSettings();
  const session = useSearchSession(settings);
  const [view, setView] = useState<'landing' | 'app'>('landing');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const capabilityImage = useMemo(() => {
    const dataUrl = session.reference.dataUrl;
    if (!dataUrl) return null;
    const comma = dataUrl.indexOf(',');
    const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
    return { data: dataUrl.slice(comma + 1), mimeType };
  }, [session.reference.dataUrl]);

  const startFromLanding = () => {
    setView('app');
    if (!settings.hasKey) setSettingsOpen(true);
  };

  return (
    <>
      {view === 'landing' ? (
        <Landing onStart={startFromLanding} hasKey={settings.hasKey} onOpenSettings={() => setSettingsOpen(true)} />
      ) : (
        <Dashboard
          session={session}
          settings={settings}
          onOpenSettings={() => setSettingsOpen(true)}
          onExit={() => setView('landing')}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        capabilityImage={capabilityImage}
      />
    </>
  );
}
