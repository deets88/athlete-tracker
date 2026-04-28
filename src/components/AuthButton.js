import { auth, googleProvider } from '../firebase';
import { signInWithPopup, signOut } from 'firebase/auth';

function AuthButton({ user, isFirebaseReady }) {
  const handleSignIn = async () => {
    if (!auth || !googleProvider) return;

    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error('Sign-in failed:', error.message);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Sign-out failed:', error.message);
    }
  };

  if (user) {
    return (
      <div className="auth-bar">
        <div className="auth-identity">
          <span className="auth-avatar">{(user.displayName || user.email || 'U').charAt(0).toUpperCase()}</span>
          <span>
            Signed in as <strong>{user.displayName || user.email}</strong>
          </span>
        </div>
        <button onClick={handleSignOut} className="auth-button auth-button-secondary">Sign out</button>
      </div>
    );
  }

  return (
    <div className="auth-bar">
      <span className="auth-note">HKIS accounts only</span>
      <button
        onClick={handleSignIn}
        className="auth-button auth-button-primary"
        disabled={!isFirebaseReady}
      >
        {isFirebaseReady ? 'Sign in with Google' : 'Firebase not configured'}
      </button>
    </div>
  );
}

export default AuthButton;