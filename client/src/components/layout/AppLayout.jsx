import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import DataBotWidget from '@/components/databot/DataBotWidget';

export default function AppLayout() {
  return (
    <div className="h-screen bg-background overflow-hidden">
      <Sidebar />
      <main className="h-screen" style={{ marginLeft: 'var(--sidebar-width, 248px)' }}>
        <div className="h-full overflow-y-auto p-6 lg:p-8">
          <Outlet />
        </div>
      </main>
      <DataBotWidget />
    </div>
  );
}