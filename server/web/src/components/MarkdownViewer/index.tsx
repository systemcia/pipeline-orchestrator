import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

interface Props {
  content: string;
}

export default function MarkdownViewer({ content }: Props) {
  if (!content) {
    return <div style={{ color: '#999', padding: 16 }}>暂无内容</div>;
  }
  return (
    <div className="markdown-body" style={{ padding: 16 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
