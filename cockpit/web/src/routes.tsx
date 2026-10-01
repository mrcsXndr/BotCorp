import { Navigate, createHashRouter } from 'react-router';
import { Kit } from './kit/Kit';
import { KitPrimitives } from './kit/KitPrimitives';
import { KitFaces } from './kit/KitFaces';
import { KitBots } from './kit/KitBots';
import { KitChat } from './kit/KitChat';
import { KitInbox } from './kit/KitInbox';
import { KitUpdates } from './kit/KitUpdates';
import { KitTools } from './kit/KitTools';
import { Shell } from './app/Shell';
import { BotsScreen } from './screens/Bots';
import { BotScreen } from './screens/bot/BotScreen';
import { AgentScreen } from './screens/bot/AgentScreen';
import { ManageScreen } from './screens/manage/ManageScreen';
import { InboxScreen } from './screens/inbox/InboxScreen';
import { AccountsScreen } from './screens/accounts/AccountsScreen';
import { UpdatesScreen } from './screens/updates/UpdatesScreen';
import { SettingsScreen } from './screens/settings/SettingsScreen';
import { HelpScreen } from './screens/help/HelpScreen';

// Hash routes: no server fallback route is needed, and the phone's Back works.
export const router = createHashRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <BotsScreen /> },
      { path: 'inbox', element: <InboxScreen /> },
      { path: 'accounts', element: <AccountsScreen /> },
      { path: 'settings', element: <SettingsScreen /> },
      { path: 'help', element: <HelpScreen /> },
      { path: 'updates', element: <UpdatesScreen /> },
      // the pages they merged into (IA §2)
      { path: 'approvals', element: <Navigate to="/inbox" replace /> },
      { path: 'usage', element: <Navigate to="/accounts" replace /> },
      { path: 'bots/:name', element: <BotScreen /> },
      { path: 'bots/:name/manage/:tab', element: <ManageScreen /> },
      { path: 'bots/:name/manage', element: <ManageScreen /> },
      { path: 'bots/:name/agents/:id', element: <AgentScreen /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
  {
    path: '/_kit',
    element: <Kit />,
    children: [
      { index: true, element: <KitPrimitives /> },
      { path: 'faces', element: <KitFaces /> },
      { path: 'bots', element: <KitBots /> },
      { path: 'chat', element: <KitChat /> },
      { path: 'inbox', element: <KitInbox /> },
      { path: 'updates', element: <KitUpdates /> },
      { path: 'tools', element: <KitTools /> },
    ],
  },
]);
