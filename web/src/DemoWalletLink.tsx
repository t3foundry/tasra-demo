import type { ReactNode } from 'react'

export const DEMO_WALLET_URL = 'https://vault.t3-foundry.fuji.tasra.network/wallet/#/'

export function DemoWalletLink({
  className = '',
  children,
}: {
  className?: string
  children?: ReactNode
}) {
  return (
    <a
      className={'demo-wallet ' + className}
      href={DEMO_WALLET_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  )
}