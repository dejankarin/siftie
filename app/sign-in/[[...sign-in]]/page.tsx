import { SignIn } from '@clerk/nextjs';
import Link from 'next/link';

const LIGHT_LOGO = '/logo/Siftie-logo-light.svg';
const DARK_LOGO = '/logo/Siftie-logo-dark.svg';

export const metadata = {
  title: 'Sign in · Siftie',
};

export default function SignInPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 px-4 py-12 bg-[var(--bg)]">
      <Link
        href="/"
        className="flex items-center"
        aria-label="Siftie home"
      >
        <span className="relative h-10 w-[150px] sm:h-12 sm:w-[180px]" aria-hidden="true">
          <img className="theme-logo-light h-full w-full object-contain" src={LIGHT_LOGO} alt="" />
          <img className="theme-logo-dark h-full w-full object-contain" src={DARK_LOGO} alt="" />
        </span>
      </Link>
      <SignIn />
    </main>
  );
}
