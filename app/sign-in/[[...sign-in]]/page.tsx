import { SignIn } from '@clerk/nextjs';

export const metadata = {
  title: 'Sign in · Siftie',
};

export default function SignInPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 px-4 py-12 bg-[var(--bg)]">
      <h1 className="leading-none">
        <span className="sr-only">Siftie</span>
        <img
          src="/logo/Siftie-logo-light.svg"
          alt=""
          aria-hidden="true"
          className="theme-logo-light h-9 w-auto"
        />
        <img
          src="/logo/Siftie-logo-dark.svg"
          alt=""
          aria-hidden="true"
          className="theme-logo-dark h-9 w-auto"
        />
      </h1>
      <SignIn />
    </main>
  );
}
