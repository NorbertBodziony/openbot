import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Button,
  Card,
  Check,
  Heading,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Kbd,
  Separator,
  SettingsSection,
  ShieldCheck,
  Skeleton,
  Spinner,
  Text,
  UserRound,
} from "../src/components/ui";

const meta = {
  title: "Foundations/Surface",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Surfaces and feedback
      </Heading>
      <div class="foundation-surface-grid">
        <Card class="foundation-surface-card">
          <Heading as="h2" size="sm">
            Card
          </Heading>
          <Text tone="secondary">A neutral container for related information and actions.</Text>
          <Separator />
          <Text variant="caption" tone="muted">
            Press <Kbd>⌘K</Kbd> to search
          </Text>
        </Card>
        <Card class="foundation-surface-card">
          <Heading as="h2" size="sm">
            Loading
          </Heading>
          <div class="foundation-story-row">
            <Spinner label="Loading content" />
            <Text tone="secondary">Loading content…</Text>
          </div>
          <div class="foundation-skeleton-stack">
            <Skeleton class="foundation-skeleton-line" />
            <Skeleton class="foundation-skeleton-line foundation-skeleton-line-short" />
          </div>
        </Card>
      </div>

      <section class="foundation-story-section" aria-labelledby="item-primitives">
        <Heading id="item-primitives" as="h2" size="sm">
          Items
        </Heading>
        <ItemGroup>
          <Item>
            <ItemMedia>
              <UserRound aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Design team</ItemTitle>
              <ItemDescription>8 members · 5 online</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button size="sm" variant="ghost">
                Manage
              </Button>
            </ItemActions>
          </Item>
          <Item size="compact">
            <ItemContent>
              <ItemTitle>Private invitation link</ItemTitle>
              <ItemDescription>Expires tomorrow at 10:00</ItemDescription>
            </ItemContent>
          </Item>
        </ItemGroup>
      </section>

      <SettingsSection
        class="foundation-story-section"
        title="Workspace preferences"
        description="Settings shared by this workspace."
        actions={
          <Button size="sm" variant="ghost">
            Manage
          </Button>
        }
      >
        <ItemGroup surface="subtle">
          <Item>
            <ItemContent>
              <ItemTitle>Restore recent workspace</ItemTitle>
              <ItemDescription>Return to the workspace from your previous session.</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button size="sm" variant="outline">
                Configure
              </Button>
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsSection>

      <section class="foundation-story-section" aria-labelledby="alert-primitives">
        <Heading id="alert-primitives" as="h2" size="sm">
          Alerts
        </Heading>
        <div class="foundation-skeleton-stack">
          <Alert tone="neutral">
            <AlertIcon>
              <ShieldCheck />
            </AlertIcon>
            <AlertContent>
              <AlertTitle>Server is private</AlertTitle>
              <AlertDescription>Publish it when you are ready to invite people.</AlertDescription>
            </AlertContent>
          </Alert>
          <Alert tone="success">
            <AlertIcon>
              <Check />
            </AlertIcon>
            <AlertContent>
              <AlertTitle>Invitation ready</AlertTitle>
              <AlertDescription>The private link can now be shared.</AlertDescription>
            </AlertContent>
            <AlertActions>
              <Button size="sm" variant="ghost">
                Copy link
              </Button>
            </AlertActions>
          </Alert>
          <Alert tone="warning">
            <AlertContent>
              <AlertTitle>Setup required</AlertTitle>
              <AlertDescription>Save the server identity before publishing.</AlertDescription>
            </AlertContent>
          </Alert>
          <Alert tone="danger" role="alert">
            <AlertContent>
              <AlertTitle>Connection failed</AlertTitle>
              <AlertDescription>The server did not respond.</AlertDescription>
            </AlertContent>
          </Alert>
        </div>
      </section>
    </main>
  ),
};
