// Configure the RNQP player before the app entry so cold-start system wakes
// (lock screen / CarPlay / assistant) find it ready. Per the RNQP setup guide
// the engine must be configured from a module, not a React effect.
import './src/services/playerBootstrap';

// Import the expo-router entry (registers the root component).
import 'expo-router/entry';
