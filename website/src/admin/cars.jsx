// import * as mutations from '../graphql/mutations';
// import * as subscriptions from '../graphql/subscriptions'

import { useCollection } from '@cloudscape-design/collection-hooks';
import {
  Button,
  ButtonDropdown,
  Header,
  Pagination,
  SpaceBetween,
  Table,
  TextFilter,
} from '@cloudscape-design/components';
import { API } from 'aws-amplify';
import React, { useEffect, useState } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';

import { useTranslation } from 'react-i18next';
import EditCarsModal from '../components/editCarsModal';
import { PageLayout } from '../components/pageLayout';
import {
  DefaultPreferences,
  EmptyState,
  MatchesCountText,
  TablePreferences,
} from '../components/tableConfig';
import { useToolsOptionsDispatch } from '../store/appLayoutProvider';

import { ColumnsConfig, VisibleContentOptions } from '../components/cars-table/carTableConfig';

import * as queries from '../graphql/queries';

const AdminCars = () => {
  const { t } = useTranslation();
  const [allItems, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedCarsBtnDisabled, setSelectedCarsBtnDisabled] = useState(true);
  const [selectedItems, setSelectedItems] = useState([]);
  const [online, setOnline] = useState('Online');
  const [onlineBool, setOnlineBool] = useState(true);
  const [refresh, setRefresh] = useState(false);

  // Help panel
  const toolsOptionsDispatch = useToolsOptionsDispatch();
  const helpPanelHidden = true;
  useEffect(() => {
    toolsOptionsDispatch({
      type: 'UPDATE',
      value: {
        //isOpen: true,
        isHidden: helpPanelHidden,
        // content: (
        //   <SimpleHelpPanelLayout
        //     headerContent={t('header', { ns: 'help-admin-cars' })}
        //     bodyContent={t('content', { ns: 'help-admin-cars' })}
        //     footerContent={t('footer', { ns: 'help-admin-cars' })}
        //   />
        // ),
      },
    });

    return () => {
      toolsOptionsDispatch({ type: 'RESET' });
    };
  }, [toolsOptionsDispatch]);

  // Get Cars
  async function getCars() {
    var thisOnlineBool = true;
    if (online !== 'Online') {
      setOnlineBool(false);
      thisOnlineBool = false;
    } else {
      setOnlineBool(true);
    }
    const response = await API.graphql({
      query: queries.carsOnline,
      variables: { online: thisOnlineBool },
    });
    setSelectedCarsBtnDisabled(true);
    setSelectedItems([]);
    setIsLoading(false);
    setItems(response.data.carsOnline);
  }

  useEffect(() => {
    getCars();
    return () => {
      // Unmounting
    };
  }, [online]);

  useEffect(() => {
    if (refresh) {
      setIsLoading(true);
      getCars();
      setRefresh(false);
    }
    return () => {
      // Unmounting
    };
  }, [refresh]);

  const [preferences, setPreferences] = useLocalStorage('DREM-cars-table-preferences', {
    ...DefaultPreferences,
    visibleContent: ['carName', 'fleetName', 'carIp'],
  });

  const columnsConfig = ColumnsConfig();
  const visibleContentOptions = VisibleContentOptions();

  const { items, actions, filteredItemsCount, collectionProps, filterProps, paginationProps } =
    useCollection(allItems, {
      filtering: {
        empty: <EmptyState title={t('cars.no-cars')} subtitle={t('cars.no-cars-message')} />,
        noMatch: (
          <EmptyState
            title={t('models.no-matches')}
            subtitle={t('models.we-cant-find-a-match')}
            action={
              <Button onClick={() => actions.setFiltering('')}>{t('table.clear-filter')}</Button>
            }
          />
        ),
      },
      pagination: { pageSize: preferences.pageSize },
      sorting: { defaultState: { sortingColumn: columnsConfig[1] } },
      selection: {},
    });

  function getLabelSync(instanceId) {
    API.graphql({
      query: queries.carPrintableLabel,
      variables: {
        instanceId: instanceId,
      },
    }).then((response) => {
      const labelURL = response.data.carPrintableLabel.toString();
      window.open(labelURL);
    });
  }

  function getLabels(event) {
    event.preventDefault();

    selectedItems.map((selectedCar) => {
      const instanceId = selectedCar.InstanceId;
      getLabelSync(instanceId);
    });
  }

  return (
    <PageLayout
      helpPanelHidden={helpPanelHidden}
      header={t('cars.header')}
      description={t('cars.description')}
      breadcrumbs={[
        { text: t('home.breadcrumb'), href: '/' },
        {
          text: t('admin.breadcrumb'),
          href: '/admin/home',
        },
        { text: t('cars.breadcrumb') },
      ]}
    >
      <Table
        {...collectionProps}
        header={
          <Header
            counter={
              selectedItems.length
                ? `(${selectedItems.length}/${allItems.length})`
                : `(${allItems.length})`
            }
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <ButtonDropdown
                  items={[
                    { text: t('cars.online'), id: 'Online', disabled: false },
                    {
                      text: t('cars.offline'),
                      id: 'Offline',
                      disabled: false,
                    },
                  ]}
                  onItemClick={({ detail }) => {
                    setOnline(detail.id);
                    setIsLoading(true);
                  }}
                >
                  {online}
                </ButtonDropdown>
                <EditCarsModal
                  disabled={selectedCarsBtnDisabled}
                  setRefresh={setRefresh}
                  selectedItems={selectedItems}
                  online={onlineBool}
                  variant="primary"
                />
                <Button variant="primary" onClick={getLabels} disabled={selectedCarsBtnDisabled}>
                  {selectedItems.length > 1
                    ? t('label-printer.download-printable-labels')
                    : t('label-printer.download-printable-label')}
                </Button>
              </SpaceBetween>
            }
          >
            {t('cars.header')}
          </Header>
        }
        columnDefinitions={columnsConfig}
        items={items}
        pagination={
          <Pagination
            {...paginationProps}
            ariaLabels={{
              nextPageLabel: t('table.next-page'),
              previousPageLabel: t('table.previous-page'),
              pageLabel: (pageNumber) => `$(t{'table.go-to-page')} ${pageNumber}`,
            }}
          />
        }
        filter={
          <TextFilter
            {...filterProps}
            countText={MatchesCountText(filteredItemsCount)}
            filteringAriaLabel={t('cars.filter-cars')}
          />
        }
        loading={isLoading}
        loadingText={t('cars.loading')}
        visibleColumns={preferences.visibleContent}
        selectionType="multi"
        stickyHeader="true"
        trackBy="InstanceId"
        selectedItems={selectedItems}
        onSelectionChange={({ detail: { selectedItems } }) => {
          setSelectedItems(selectedItems);
          selectedItems.length
            ? setSelectedCarsBtnDisabled(false)
            : setSelectedCarsBtnDisabled(true);
        }}
        resizableColumns
        preferences={
          <TablePreferences
            preferences={preferences}
            setPreferences={setPreferences}
            contentOptions={visibleContentOptions}
          />
        }
      />
    </PageLayout>
  );
};

export { AdminCars };
