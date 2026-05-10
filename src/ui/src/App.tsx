import { useState } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Container, Row, Col } from 'react-bootstrap';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTachometerAlt, faFloppyDisk, faCog, faBook } from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import Dashboard from './views/Dashboard/Dashboard';
import BackupsPage from './views/Backups/BackupsPage';
import SettingsPage from './views/Settings/SettingsPage';
import SignalKLogo from './components/SignalKLogo';
import { apiUrl } from './api';
import 'bootstrap/dist/css/bootstrap.min.css';
import './styles.css';

interface NavItem {
  id: string;
  path: string;
  label: string;
  icon: IconDefinition;
  external?: boolean;
  href?: string;
}

const navItems: NavItem[] = [
  { id: 'dashboard', path: '/', label: 'Dashboard', icon: faTachometerAlt },
  { id: 'backups', path: '/backups', label: 'Backups', icon: faFloppyDisk },
  { id: 'settings', path: '/settings', label: 'Settings', icon: faCog },
];

const apiLinks: NavItem[] = [
  {
    id: 'swagger',
    path: '',
    label: 'REST API (Swagger)',
    icon: faBook,
    external: true,
    href: apiUrl('/api/docs'),
  },
];

const App = () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const isActive = (path: string): boolean => {
    if (path === '/') return location.pathname === '/' || location.pathname === '';
    return location.pathname.startsWith(path);
  };

  const toggleSidebar = () => setSidebarOpen(!sidebarOpen);

  const handleNavClick = (item: NavItem) => {
    if (item.external && item.href) {
      window.open(item.href, '_blank');
    } else {
      navigate(item.path);
      setSidebarOpen(false);
    }
  };

  const version = import.meta.env.VITE_APP_VERSION || '0.0.0';

  return (
    <div className="sk-app">
      {/* Header */}
      <header className="sk-header">
        <button className="sk-menu-toggle" onClick={toggleSidebar} aria-label="Toggle navigation">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path d="M2 4h16v2H2V4zm0 5h16v2H2V9zm0 5h16v2H2v-2z" />
          </svg>
        </button>
        <div className="sk-header-brand">
          <SignalKLogo height={35} />
        </div>
        <nav className="sk-header-nav" />
      </header>

      {/* App Body */}
      <div className="sk-app-body">
        {/* Sidebar */}
        <aside className={`sk-sidebar ${sidebarOpen ? 'open' : ''}`}>
          <nav className="sk-sidebar-nav">
            <div className="sk-sidebar-nav-title">SignalK Backup</div>
            {navItems.map((item) => (
              <div key={item.id} className="sk-sidebar-nav-item">
                <a
                  href={`#${item.path}`}
                  className={`sk-sidebar-nav-link ${isActive(item.path) ? 'active' : ''}`}
                  onClick={(e) => {
                    e.preventDefault();
                    handleNavClick(item);
                  }}
                >
                  <FontAwesomeIcon icon={item.icon} className="sk-nav-icon" />
                  <span>{item.label}</span>
                </a>
              </div>
            ))}

            <div className="sk-sidebar-nav-title">API</div>
            {apiLinks.map((item) => (
              <div key={item.id} className="sk-sidebar-nav-item">
                <a
                  href={item.href}
                  className="sk-sidebar-nav-link sk-external-link"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setSidebarOpen(false)}
                >
                  <FontAwesomeIcon icon={item.icon} className="sk-nav-icon" />
                  <span>{item.label}</span>
                </a>
              </div>
            ))}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="sk-main">
          <Container fluid>
            <Row>
              <Col xs={12}>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/backups" element={<BackupsPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Col>
            </Row>
          </Container>
        </main>
      </div>

      {/* Footer */}
      <footer className="sk-footer">
        <span>
          <a
            href="https://github.com/signalk/signalk-backup-server"
            target="_blank"
            rel="noopener noreferrer"
          >
            SignalK Backup
          </a>
          <span className="sk-version">v{version}</span>
        </span>
        <span className="sk-footer-right">
          <a href="https://opencollective.com/signalk" target="_blank" rel="noopener noreferrer">
            Sponsor Signal K
          </a>
        </span>
      </footer>
    </div>
  );
};

export default App;
