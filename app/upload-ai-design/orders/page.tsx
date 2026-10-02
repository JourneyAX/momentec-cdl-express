import { listOrders } from "@/lib/upload-ai-orders";
import "./orders.css";

export const dynamic = "force-dynamic";

export default function UploadAiOrdersPage() {
  const orders = listOrders();
  return (
    <main className="upload-ai-orders">
      <h1>Designs</h1>
      <p>Keep refreshing the page to view the updates.</p>
      {orders.length === 0 ? (
        <p>No designs yet.</p>
      ) : (
        <ul>
          {orders.map((order) => (
            <li key={order.id}>
              <strong>{order.name}</strong>
              <p>Design received</p>
              {order.status === "failed" ? (
                <p className="is-failed">Assets could not be created</p>
              ) : order.ready ? (
                <p className="is-received">Assets ready</p>
              ) : (
                <p className="is-waiting">Assets creation in progress</p>
              )}
              {order.ready ? <a href={`/api/upload-ai-design/orders/${order.id}`}>Download assets</a> : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
