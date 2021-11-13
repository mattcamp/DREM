import React, {useState} from 'react'
import { Table, Button, Modal } from 'semantic-ui-react'

function uploadModelToCar(car, model) {
  console.log(car.InstanceId)
  console.log(model.key)
}

function CarModelUploadModal(props) {
  const [open, setOpen] = useState(false)

  //let cars = collectCars()
  //let cars = [];
  //console.log(cars.cars);
  //console.log('model')
  //console.log(props.model)

  var modaltablerows = props.cars.map(function (car, i) {
    return <Table.Row key={i} >
      <Table.Cell>{car.ComputerName} </Table.Cell>
      <Table.Cell><Button content="Upload" labelPosition='right' icon='upload' onClick={() => {setOpen(false); uploadModelToCar(car, props.model) }} positive /></Table.Cell>
    </Table.Row>
  });

  return (
    
    <Modal
      onClose={() => setOpen(false)}
      onOpen={() => setOpen(true)}
      open={open}
      trigger={<Button positive circular icon='upload' />}
    >
      <Modal.Header>Select a Car</Modal.Header>
      <Modal.Content>
        <p>
          Pick a car
        </p>
        <Table>
          <Table.Body>
            {modaltablerows}
          </Table.Body>
        </Table>
      </Modal.Content>
      <Modal.Actions>
        <Button color='red' onClick={() => setOpen(false)}>Close</Button>
      </Modal.Actions>
    </Modal>
  )
}

export default CarModelUploadModal
