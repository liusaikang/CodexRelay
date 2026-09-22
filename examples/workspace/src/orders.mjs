export function listOrders(membership, orders) {
  return orders.filter(order => order.tenantId === membership.tenantId);
}
