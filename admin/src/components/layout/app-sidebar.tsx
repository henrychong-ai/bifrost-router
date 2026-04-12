import { Link, useLocation } from 'react-router-dom';
import {
  ArrowUpRight,
  Eye,
  Download,
  Globe,
  Route,
  LayoutDashboard,
  ClipboardList,
  HardDrive,
  ScrollText,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from '@/components/ui/sidebar';

const navigationItems = [
  {
    title: 'Dashboard',
    href: '/',
    icon: LayoutDashboard,
  },
  {
    title: 'Routes',
    href: '/routes',
    icon: Route,
  },
  {
    title: 'Storage',
    href: '/storage',
    icon: HardDrive,
  },
  {
    title: 'Audit',
    href: '/audit',
    icon: ClipboardList,
  },
];

const analyticsItems = [
  {
    title: 'Redirects',
    href: '/analytics/redirects',
    icon: ArrowUpRight,
  },
  {
    title: 'Views',
    href: '/analytics/views',
    icon: Eye,
  },
  {
    title: 'Downloads',
    href: '/analytics/downloads',
    icon: Download,
  },
  {
    title: 'Proxy',
    href: '/analytics/proxy',
    icon: Globe,
  },
];

export function AppSidebar() {
  const location = useLocation();

  const isActive = (href: string) => {
    if (href === '/') {
      return location.pathname === '/';
    }
    return location.pathname.startsWith(href);
  };

  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border px-6 py-4">
        <div className="flex items-center gap-3">
          <img
            src="https://assets.example.com/bifrost/bifrost-icon-64.png"
            alt="Bifrost"
            className="h-10 w-10 rounded-lg"
          />
          <div className="flex flex-col">
            <span className="font-gilroy font-semibold text-white">Bifrost</span>
            <span className="text-tiny text-sidebar-foreground/60">Analytics Dashboard</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-2">
        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-foreground/50 font-gilroy uppercase text-tiny tracking-wider">
            Navigation
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigationItems.map(item => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.href)}
                    className="font-gilroy transition-all duration-200"
                  >
                    <Link to={item.href}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-sidebar-foreground/50 font-gilroy uppercase text-tiny tracking-wider">
            Analytics
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {analyticsItems.map(item => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.href)}
                    className="font-gilroy transition-all duration-200"
                  >
                    <Link to={item.href}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {/* Changelog — pinned to bottom of sidebar content */}
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={isActive('/changelog')}
                  className="font-gilroy transition-all duration-200 hover:translate-x-1"
                >
                  <Link to="/changelog" className="group/link">
                    <ScrollText className="size-4 transition-transform duration-200 group-hover/link:scale-110" />
                    <span>Changelog</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border px-6 py-4">
        {/* Gold accent bar */}
        <div className="h-1 w-full rounded-full gradient-accent-bar mb-3" />
        <Link
          to="/changelog"
          className="font-gilroy text-tiny text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground/80"
        >
          Bifrost v{__APP_VERSION__}
        </Link>
      </SidebarFooter>
    </Sidebar>
  );
}
