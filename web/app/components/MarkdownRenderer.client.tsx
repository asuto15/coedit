'use client'

import dynamic from 'next/dynamic'

export const CodeBlock = dynamic(() => import('./CodeBlock'), { ssr: false })

