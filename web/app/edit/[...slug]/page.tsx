import EditPageClient from './EditPageClient'

type SlugParams = { slug?: string[] }

type PageProps = {
  params: SlugParams | Promise<SlugParams>
}

export default async function EditPage({ params }: PageProps) {
  const resolved = params instanceof Promise ? await params : params
  const slugParts = resolved.slug ?? []
  return <EditPageClient slugParts={slugParts} />
}
