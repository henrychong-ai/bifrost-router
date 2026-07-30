import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { BookOpen, Compass, QrCode, Route } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getWelcomeSeen, persistWelcomeSeen } from '@/lib/constants';

/**
 * First-visit orientation dialog (v1.30.0 — ported from the internal
 * deployments' v1.56.0, simplified for the single-operator template: no
 * role personalisation). Shown once per browser; EVERY dismissal path marks
 * it seen so it never re-prompts.
 */
export function WelcomeDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current) return;
    decided.current = true;
    if (getWelcomeSeen()) return;
    setOpen(true);
  }, []);

  const dismiss = () => {
    persistWelcomeSeen();
    setOpen(false);
  };

  const openGuide = () => {
    dismiss();
    navigate('/guide');
  };

  return (
    <Dialog open={open} onOpenChange={next => !next && dismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-inter font-semibold text-blue-950">
            Welcome to Bifrost
          </DialogTitle>
          <DialogDescription className="font-inter">
            Branded short links, file serving, QR codes, and analytics — all live within seconds.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 font-inter text-small text-charcoal-700">
          <div className="flex gap-3">
            <Route className="mt-0.5 size-4 shrink-0 text-blue-600" />
            <p>
              A <strong>route</strong> is a path plus a behaviour — redirect, proxy, or file
              serving. Create one and it is live worldwide in seconds.
            </p>
          </div>
          <div className="flex gap-3">
            <QrCode className="mt-0.5 size-4 shrink-0 text-blue-600" />
            <p>
              <strong>QR codes</strong> can link to a route, so a printed code keeps working when
              you re-point the destination — re-point, never reprint.
            </p>
          </div>
          <div className="flex gap-3">
            <Compass className="mt-0.5 size-4 shrink-0 text-blue-600" />
            <p>
              The <strong>User Guide</strong> in the sidebar covers everything from your first short
              link to the AI/MCP integrations.
            </p>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" className="font-inter" onClick={dismiss}>
            Explore on my own
          </Button>
          <Button className="font-inter" onClick={openGuide}>
            <BookOpen className="size-4" />
            Open the User Guide
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
