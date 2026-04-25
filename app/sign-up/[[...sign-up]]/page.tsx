import { SignUp } from '@clerk/nextjs';

export const metadata = {
  title: 'Sign up · Siftie',
};

export default function SignUpPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 px-4 py-12 bg-[var(--bg)]">
      <h1 className="font-[Instrument_Serif] text-[40px] leading-none tracking-tight text-[var(--ink)]">
        Siftie
      </h1>
      <SignUp />
    </main>
  );
}
